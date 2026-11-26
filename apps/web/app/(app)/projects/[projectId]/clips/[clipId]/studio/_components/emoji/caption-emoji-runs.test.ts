import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildEditedTimeMap,
  CAPTION_EMOJI_LIMIT,
  captionWordKey,
  replaceCaptionEmojis,
  type CaptionEmojiRef,
  type EditorDocument,
} from "@narriflow/validators";
import { emojiFixtureDocument, emojiFixtureManyLines } from "./caption-emoji-fixture";
import {
  captionEmojiFingerprint,
  captionEmojiRunTransition,
  captionEmojiSession,
  captionEmojisNeedConfirm,
  countCommittedPicks,
  planCaptionEmojiAnswer,
  registerCaptionEmojiSource,
  resetCaptionEmojiSessions,
  runCaptionEmojiSuggestion,
  type CaptionEmojiAnswer,
  type CaptionEmojiLiveSource,
  type CaptionEmojiRun,
} from "./caption-emoji-runs";
import { captionEmojiWords, placeCaptionEmojis, type CaptionEmojiWords } from "./caption-emoji-words";

type Emojis = Record<string, CaptionEmojiRef>;

const modelOf = (document: EditorDocument): CaptionEmojiWords =>
  captionEmojiWords(document, buildEditedTimeMap(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec }));

const base = emojiFixtureDocument({ presetId: "bold-pop" });
const keyOf = (line: number, word: number) => captionWordKey(base.transcriptSlice[line]!.words[word]!.startSec);

/** `base` with one word's text replaced, keeping its timestamp (a line rewrite that keeps timing). */
function rewriteWord(document: EditorDocument, line: number, word: number, text: string): EditorDocument {
  const transcriptSlice = document.transcriptSlice.map((utterance, at) => {
    if (at !== line) return utterance;
    const words = utterance.words.map((entry, index) => (index === word ? { ...entry, word: text } : entry));
    return { ...utterance, words, text: words.map((entry) => entry.word).join(" ") };
  });
  return { ...document, transcriptSlice };
}

function cutWord(document: EditorDocument, line: number, word: number): EditorDocument {
  const target = document.transcriptSlice[line]!.words[word]!;
  return { ...document, deletedRanges: [{ startSec: target.startSec - 0.01, endSec: target.endSec + 0.01 }] };
}

/** A mounted editor's live view over a document it can write (the reducer's 500 cap included). */
function fakeSource(initial: EditorDocument, options: { readOnly?: boolean } = {}) {
  let document = initial;
  const replaced: Emojis[] = [];
  const source = {
    get document() {
      return document;
    },
    set document(next: EditorDocument) {
      document = next;
    },
    replaced,
    read: (): CaptionEmojiLiveSource => ({
      entries: document.studioEdits.captionEmojis,
      model: modelOf(document),
      readOnly: options.readOnly ?? false,
      replace: (value) => {
        replaced.push(value);
        const studioEdits = replaceCaptionEmojis(document.studioEdits, value);
        if (studioEdits) document = { ...document, studioEdits };
        return document.studioEdits.captionEmojis;
      },
    }),
    handEdit: (key: string, ref: CaptionEmojiRef | null) => {
      const next: Emojis = { ...document.studioEdits.captionEmojis };
      if (ref) next[key] = ref;
      else delete next[key];
      document = { ...document, studioEdits: replaceCaptionEmojis(document.studioEdits, next)! };
    },
  };
  return source;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function request(answer: Promise<CaptionEmojiAnswer>, save: () => Promise<boolean> = async () => true) {
  let calls = 0;
  return {
    calls: () => calls,
    deps: {
      save,
      suggest: () => {
        calls += 1;
        return answer;
      },
      failureCode: (error: unknown) => (error as { code?: string }).code ?? null,
    },
  };
}

const flush = () => Bun.sleep(0);

beforeEach(() => resetCaptionEmojiSessions());

describe("what was tagged", () => {
  test("the fingerprint holds the shown words' keys and texts; cut and censored words are not in it", () => {
    const cut = cutWord(base, 1, 3);
    const fingerprint = captionEmojiFingerprint(modelOf(cut));
    expect(fingerprint.get(keyOf(0, 2))).toBe(base.transcriptSlice[0]!.words[2]!.word);
    expect(fingerprint.has(keyOf(1, 3))).toBe(false);
  });
});

describe("merging an answer", () => {
  const without = { ...base, studioEdits: replaceCaptionEmojis(base.studioEdits, {})! };

  test("a pick whose word was rewritten at the same timestamp is dropped (party → hospital)", () => {
    const tagged = rewriteWord(without, 0, 2, "party");
    const now = rewriteWord(without, 0, 2, "hospital");
    const plan = planCaptionEmojiAnswer({
      start: undefined,
      current: undefined,
      answer: { emojis: { [keyOf(0, 2)]: { id: "party" }, [keyOf(1, 3)]: { id: "money-bag" } } },
      fingerprint: captionEmojiFingerprint(modelOf(tagged)),
      model: modelOf(now),
    });
    expect(plan).toEqual({ kind: "replace", value: { [keyOf(1, 3)]: { id: "money-bag" } }, picks: { [keyOf(1, 3)]: { id: "money-bag" } }, leftOut: 0, partial: false });
  });

  test("a pick on a word cut since tagging is dropped against the current cuts", () => {
    const plan = planCaptionEmojiAnswer({
      start: undefined,
      current: undefined,
      answer: { emojis: { [keyOf(1, 3)]: { id: "money-bag" }, [keyOf(2, 2)]: { id: "party" } } },
      fingerprint: captionEmojiFingerprint(modelOf(without)),
      model: modelOf(cutWord(without, 1, 3)),
    });
    expect(plan.kind === "replace" && plan.value).toEqual({ [keyOf(2, 2)]: { id: "party" } });
  });

  test("edits made while the run was out win over the answer", () => {
    const start = { [keyOf(0, 2)]: { id: "bulb" }, [keyOf(1, 1)]: { id: "rocket" } };
    const current = { [keyOf(0, 2)]: { id: "bulb" }, [keyOf(2, 2)]: { id: "party" } };
    const plan = planCaptionEmojiAnswer({
      start,
      current,
      answer: { emojis: { [keyOf(0, 2)]: { id: "sparkles" }, [keyOf(1, 1)]: { id: "flame" }, [keyOf(3, 1)]: { id: "crown" } } },
      fingerprint: captionEmojiFingerprint(modelOf(base)),
      model: modelOf(base),
    });
    expect(plan.kind === "replace" && plan.value).toEqual({
      [keyOf(0, 2)]: { id: "sparkles" },
      [keyOf(2, 2)]: { id: "party" },
      [keyOf(3, 1)]: { id: "crown" },
    });
  });

  test("the merge is trimmed to the cap: hand edits first, then the earliest picks", () => {
    const model = modelOf(emojiFixtureManyLines({ presetId: "bold-pop", lines: 60, wordsPerLine: 10 }));
    const shown = model.words.filter((word) => word.editedStartSec !== null);
    // More words than the cap: picks on the first 500, a hand edit on word 501.
    expect(shown.length).toBeGreaterThan(CAPTION_EMOJI_LIMIT);
    const picks = Object.fromEntries(shown.slice(0, CAPTION_EMOJI_LIMIT).map((word) => [word.key, { id: "flame" }]));
    const hand = shown[CAPTION_EMOJI_LIMIT]!.key;
    const plan = planCaptionEmojiAnswer({ start: {}, current: { [hand]: { id: "crown" } }, answer: { emojis: picks }, fingerprint: captionEmojiFingerprint(model), model });
    if (plan.kind !== "replace") throw new Error(plan.kind);
    expect(Object.keys(plan.value)).toHaveLength(CAPTION_EMOJI_LIMIT);
    expect(plan.value[hand]).toEqual({ id: "crown" });
    expect(plan.value[shown[CAPTION_EMOJI_LIMIT - 1]!.key]).toBeUndefined();
    expect(plan.value[shown[0]!.key]).toEqual({ id: "flame" });
    expect(plan.leftOut).toBe(1);
    expect(Object.keys(plan.picks)).toHaveLength(CAPTION_EMOJI_LIMIT - 1);
  });

  test("an incomplete answer never replaces existing emojis; on a clip without emojis it keeps what was tagged", () => {
    const answer = { emojis: { [keyOf(1, 3)]: { id: "money-bag" } }, complete: false };
    const fingerprint = captionEmojiFingerprint(modelOf(base));
    expect(planCaptionEmojiAnswer({ start: base.studioEdits.captionEmojis, current: base.studioEdits.captionEmojis, answer, fingerprint, model: modelOf(base) })).toEqual({ kind: "incomplete" });
    expect(planCaptionEmojiAnswer({ start: undefined, current: undefined, answer, fingerprint, model: modelOf(without) })).toMatchObject({ kind: "replace", partial: true });
    expect(planCaptionEmojiAnswer({ start: undefined, current: undefined, answer: { emojis: {}, complete: false }, fingerprint, model: modelOf(without) })).toEqual({ kind: "incomplete" });
  });

  test("an answer without `complete` counts as complete; an empty one changes nothing", () => {
    const fingerprint = captionEmojiFingerprint(modelOf(base));
    expect(planCaptionEmojiAnswer({ start: undefined, current: undefined, answer: { emojis: { [keyOf(1, 3)]: { id: "flame" } } }, fingerprint, model: modelOf(without) })).toMatchObject({ partial: false });
    expect(planCaptionEmojiAnswer({ start: base.studioEdits.captionEmojis, current: base.studioEdits.captionEmojis, answer: { emojis: {} }, fingerprint, model: modelOf(base) })).toEqual({ kind: "empty" });
  });
});

describe("what was committed", () => {
  test("only picks the document holds count", () => {
    const picks = { a: { id: "flame" }, b: { id: "crown" }, c: { id: "party" } };
    expect(countCommittedPicks(picks, { a: { id: "flame" }, b: { id: "rocket" } })).toBe(1);
    expect(countCommittedPicks(picks, undefined)).toBe(0);
  });
});

describe("run states", () => {
  const running: CaptionEmojiRun = { status: "running", density: "balanced" };
  test("a busy run ignores start and dismiss; a save leads to running; a finished run dismisses to idle", () => {
    expect(captionEmojiRunTransition({ status: "idle" }, { type: "start", density: "light" })).toEqual({ status: "saving", density: "light" });
    expect(captionEmojiRunTransition({ status: "saving", density: "light" }, { type: "start", density: "expressive" })).toEqual({ status: "saving", density: "light" });
    expect(captionEmojiRunTransition({ status: "saving", density: "light" }, { type: "saved" })).toEqual({ status: "running", density: "light" });
    expect(captionEmojiRunTransition(running, { type: "dismiss" })).toBe(running);
    expect(captionEmojiRunTransition(running, { type: "done", added: 3, leftOut: 0, partial: false })).toEqual({ status: "done", added: 3, leftOut: 0, partial: false });
    expect(captionEmojiRunTransition({ status: "done", added: 3, leftOut: 0, partial: false }, { type: "dismiss" })).toEqual({ status: "idle" });
    expect(captionEmojiRunTransition({ status: "idle" }, { type: "done", added: 3, leftOut: 0, partial: false })).toEqual({ status: "idle" });
  });
});

describe("AI runs against the live sources", () => {
  test("panel closed mid-run, then a hand edit from a transcript chip: the hand edit survives the answer", async () => {
    const answer = deferred<CaptionEmojiAnswer>();
    const panel = fakeSource(base);
    const rows = fakeSource(base);
    const unregisterPanel = registerCaptionEmojiSource("clip", panel.read);
    registerCaptionEmojiSource("clip", rows.read);
    const run = runCaptionEmojiSuggestion("clip", "balanced", request(answer.promise).deps);
    await flush();
    unregisterPanel();
    rows.handEdit(keyOf(2, 4), { id: "party" });
    answer.resolve({ emojis: { [keyOf(1, 3)]: { id: "money-bag" } } });
    await run;
    expect(panel.replaced).toEqual([]);
    expect(rows.document.studioEdits.captionEmojis).toEqual({ [keyOf(1, 3)]: { id: "money-bag" }, [keyOf(2, 4)]: { id: "party" } });
    expect(captionEmojiSession("clip").run).toEqual({ status: "done", added: 1, leftOut: 0, partial: false });
  });

  test("clip switched mid-run: the answer is dropped", async () => {
    const answer = deferred<CaptionEmojiAnswer>();
    const first = fakeSource(base);
    const second = fakeSource(base);
    const unregister = registerCaptionEmojiSource("clip-a", first.read);
    const run = runCaptionEmojiSuggestion("clip-a", "balanced", request(answer.promise).deps);
    await flush();
    unregister();
    registerCaptionEmojiSource("clip-b", second.read);
    answer.resolve({ emojis: { [keyOf(1, 3)]: { id: "money-bag" } } });
    await run;
    expect(first.replaced).toEqual([]);
    expect(second.replaced).toEqual([]);
    expect(captionEmojiSession("clip-a").run).toEqual({ status: "failed", failure: { reason: "closed" } });
  });

  test("two editors mounted: one dispatch", async () => {
    const one = fakeSource(base);
    const two = fakeSource(base);
    registerCaptionEmojiSource("clip", one.read);
    registerCaptionEmojiSource("clip", two.read);
    await runCaptionEmojiSuggestion("clip", "balanced", request(Promise.resolve({ emojis: { [keyOf(1, 3)]: { id: "money-bag" } } })).deps);
    expect(one.replaced.length + two.replaced.length).toBe(1);
  });

  test("a save that cannot finish stops the run before the model is called", async () => {
    const source = fakeSource(base);
    registerCaptionEmojiSource("clip", source.read);
    const r = request(Promise.resolve({ emojis: {} }), async () => false);
    await runCaptionEmojiSuggestion("clip", "balanced", r.deps);
    expect(r.calls()).toBe(0);
    expect(captionEmojiSession("clip").run).toEqual({ status: "failed", failure: { reason: "save" } });
  });

  test("a rewrite during the run drops the pick on the rewritten word", async () => {
    const answer = deferred<CaptionEmojiAnswer>();
    const tagged = rewriteWord({ ...base, studioEdits: replaceCaptionEmojis(base.studioEdits, {})! }, 0, 2, "party");
    const source = fakeSource(tagged);
    registerCaptionEmojiSource("clip", source.read);
    const run = runCaptionEmojiSuggestion("clip", "balanced", request(answer.promise).deps);
    await flush();
    source.document = rewriteWord(source.document, 0, 2, "hospital");
    answer.resolve({ emojis: { [keyOf(0, 2)]: { id: "party" } } });
    await run;
    expect(source.document.studioEdits.captionEmojis).toBeUndefined();
    expect(captionEmojiSession("clip").run).toEqual({ status: "done", added: 0, leftOut: 0, partial: false });
  });

  test("500 picks in flight and one hand-placed emoji: 500 stored, the count and baseline from what was committed", async () => {
    const empty = emojiFixtureManyLines({ presetId: "bold-pop", lines: 60, wordsPerLine: 10 });
    const shown = modelOf(empty).words.filter((word) => word.editedStartSec !== null);
    const answer = deferred<CaptionEmojiAnswer>();
    const source = fakeSource(empty);
    registerCaptionEmojiSource("clip", source.read);
    const run = runCaptionEmojiSuggestion("clip", "expressive", request(answer.promise).deps);
    await flush();
    source.handEdit(shown[CAPTION_EMOJI_LIMIT]!.key, { id: "crown" });
    answer.resolve({ emojis: Object.fromEntries(shown.slice(0, CAPTION_EMOJI_LIMIT).map((word) => [word.key, { id: "flame" }])) });
    await run;
    const stored = source.document.studioEdits.captionEmojis!;
    expect(Object.keys(stored)).toHaveLength(CAPTION_EMOJI_LIMIT);
    expect(stored[shown[CAPTION_EMOJI_LIMIT]!.key]).toEqual({ id: "crown" });
    expect(captionEmojiSession("clip").run).toEqual({ status: "done", added: CAPTION_EMOJI_LIMIT - 1, leftOut: 1, partial: false });
    // The crown was placed by hand: the next Regenerate would remove it, so it asks first.
    expect(captionEmojisNeedConfirm("clip", stored)).toBe(true);
  });

  test("Regenerate on an incomplete answer keeps the emojis and says it could not finish", async () => {
    const source = fakeSource(base);
    registerCaptionEmojiSource("clip", source.read);
    await runCaptionEmojiSuggestion("clip", "balanced", request(Promise.resolve({ emojis: { [keyOf(1, 3)]: { id: "flame" } }, complete: false })).deps);
    expect(source.replaced).toEqual([]);
    expect(captionEmojiSession("clip").run).toEqual({ status: "failed", failure: { reason: "incomplete" } });
  });

  test("a tab that lost the write lease while waiting applies nothing", async () => {
    let readOnly = false;
    const source = fakeSource(base);
    registerCaptionEmojiSource("clip", () => ({ ...source.read(), readOnly }));
    const answer = deferred<CaptionEmojiAnswer>();
    const run = runCaptionEmojiSuggestion("clip", "balanced", request(answer.promise).deps);
    await flush();
    readOnly = true;
    answer.resolve({ emojis: { [keyOf(1, 3)]: { id: "flame" } } });
    await run;
    expect(source.replaced).toEqual([]);
    expect(captionEmojiSession("clip").run).toEqual({ status: "failed", failure: { reason: "read_only" } });
  });

  test("a failed request keeps its typed code; a second start while one runs is ignored", async () => {
    registerCaptionEmojiSource("clip", fakeSource(base).read);
    const r = request(Promise.reject({ code: "openai_rate_limited" }));
    const first = runCaptionEmojiSuggestion("clip", "balanced", r.deps);
    await runCaptionEmojiSuggestion("clip", "balanced", r.deps);
    await first;
    expect(r.calls()).toBe(1);
    expect(captionEmojiSession("clip").run).toEqual({ status: "failed", failure: { reason: "request", code: "openai_rate_limited" } });
  });
});

/** `base` with one subtitle line per entry of `lines` (word, source start; each word 0.18 s) and these emojis. */
function speech(lines: readonly (readonly (readonly [string, number])[])[], emojis: Emojis = {}): EditorDocument {
  const transcriptSlice = lines.map((words, index) => ({
    index,
    speaker: 0,
    speakerLabel: "Speaker 1",
    startSec: words[0]![1],
    endSec: words.at(-1)![1] + 0.18,
    confidence: 1,
    text: words.map(([word]) => word).join(" "),
    words: words.map(([word, startSec]) => ({ word, startSec, endSec: startSec + 0.18, confidence: 1 })),
  }));
  return { ...base, transcriptSlice, studioEdits: replaceCaptionEmojis(base.studioEdits, emojis)! };
}

/** Starts a run on `document`, applies `during` while the request is out, then answers with `emojis`. */
async function runWith(document: EditorDocument, during: (source: ReturnType<typeof fakeSource>) => void, emojis: Emojis) {
  const answer = deferred<CaptionEmojiAnswer>();
  const source = fakeSource(document);
  registerCaptionEmojiSource("clip", source.read);
  const run = runCaptionEmojiSuggestion("clip", "balanced", request(answer.promise).deps);
  await flush();
  during(source);
  answer.resolve({ emojis, complete: true });
  await run;
  return source;
}

const shownOn = (document: EditorDocument) => {
  const model = modelOf(document);
  return Object.fromEntries([...placeCaptionEmojis(document.studioEdits.captionEmojis, model).byWord].map(([word, placed]) => [model.words[word]!.text, placed.ref.id]));
};

describe("an AI pick lands only on the word it was made for", () => {
  const party = speech([[["party", 0.8]], [["hospital", 1], ["today", 1.5]]]);

  test("its word's line deleted during the run: the pick is dropped, not moved to the next line's word", async () => {
    const source = await runWith(party, (live) => (live.document = { ...live.document, transcriptSlice: live.document.transcriptSlice.slice(1) }), { "800": { id: "party-popper" } });
    expect(source.document.studioEdits.captionEmojis).toBeUndefined();
    expect(captionEmojiSession("clip").run).toEqual({ status: "done", added: 0, leftOut: 0, partial: false });
  });

  test("its word re-timed during the run: the pick is dropped, not given to the word now nearest its key", async () => {
    const tagged = speech([[["a", 0.5], ["party", 0.8], ["hospital", 1]]]);
    // A line rewrite moved "party" after "hospital": 0.8 s is now nearest to "hospital", whose own key and text are unchanged.
    const source = await runWith(tagged, (live) => (live.document = speech([[["a", 0.5], ["hospital", 1], ["party", 1.25]]])), { "800": { id: "party-popper" } });
    expect(source.document.studioEdits.captionEmojis).toBeUndefined();
  });

  test("its word unchanged: the pick is kept on it", async () => {
    const source = await runWith(party, () => {}, { "800": { id: "party-popper" } });
    expect(shownOn(source.document)).toEqual({ party: "party-popper" });
  });

  test("its word's line deleted and restored (undo) during the run: the same key and text, so the pick is kept", async () => {
    const source = await runWith(
      party,
      (live) => {
        const tagged = live.document;
        live.document = { ...tagged, transcriptSlice: tagged.transcriptSlice.slice(1) };
        live.document = tagged;
      },
      { "800": { id: "party-popper" } },
    );
    expect(shownOn(source.document)).toEqual({ party: "party-popper" });
  });

  test("a key two words share when tagged is dropped: the answer cannot say which word it means", () => {
    const shared = speech([[["party", 0.8]], [["hello", 0.8], ["today", 1.5]]]);
    for (const document of [shared, { ...shared, transcriptSlice: [...shared.transcriptSlice].reverse() }]) {
      const model = modelOf(document);
      const plan = planCaptionEmojiAnswer({ start: undefined, current: undefined, answer: { emojis: { "800": { id: "party-popper" }, "1500": { id: "sun" } } }, fingerprint: captionEmojiFingerprint(model), model });
      expect(plan.kind === "replace" && plan.value).toEqual({ "1500": { id: "sun" } });
    }
  });

  test("a hand edit during the run on the pick's word, stored a few ms off its key, keeps the word", async () => {
    const offKey = speech([[["party", 0.8]], [["hospital", 1], ["today", 1.5]]], { "805": { id: "rocket" } });
    const source = await runWith(offKey, (live) => live.handEdit("805", { id: "flame" }), { "800": { id: "party-popper" }, "1500": { id: "sun" } });
    expect(source.document.studioEdits.captionEmojis).toEqual({ "805": { id: "flame" }, "1500": { id: "sun" } });
    expect(shownOn(source.document)).toEqual({ party: "flame", today: "sun" });
  });
});

describe("hand edits are never AI output", () => {
  test("a hand edit made during a run is kept and is not part of the AI baseline: the next Regenerate asks first", async () => {
    const empty = speech([[["party", 0.8]], [["hospital", 1], ["today", 1.5]]]);
    const source = await runWith(empty, (live) => live.handEdit("1500", { id: "flame" }), { "800": { id: "party-popper" } });
    const stored = source.document.studioEdits.captionEmojis;
    expect(stored).toEqual({ "800": { id: "party-popper" }, "1500": { id: "flame" } });
    expect(captionEmojisNeedConfirm("clip", stored)).toBe(true);
    // Without the hand edit, the AI's own picks need no confirm.
    resetCaptionEmojiSessions();
    const clean = await runWith(empty, () => {}, { "800": { id: "party-popper" } });
    expect(captionEmojisNeedConfirm("clip", clean.document.studioEdits.captionEmojis)).toBe(false);
  });

  test("Add with AI on a clip whose emojis are all hidden (on cut words) keeps them and adds the picks", async () => {
    const hidden = { ...speech([[["party", 0.8]], [["hospital", 1], ["today", 1.5]]], { "800": { id: "rocket" } }), deletedRanges: [{ startSec: 0.79, endSec: 0.99 }] };
    expect(placeCaptionEmojis(hidden.studioEdits.captionEmojis, modelOf(hidden)).shown).toBe(0);
    const source = await runWith(hidden, () => {}, { "1000": { id: "hospital" } });
    expect(source.document.studioEdits.captionEmojis).toEqual({ "800": { id: "rocket" }, "1000": { id: "hospital" } });
    expect(captionEmojisNeedConfirm("clip", source.document.studioEdits.captionEmojis)).toBe(true);
  });

  test("Regenerate (emojis that show) replaces them, and keeps those changed during the run", async () => {
    const shown = speech([[["party", 0.8]], [["hospital", 1], ["today", 1.5]]], { "800": { id: "rocket" }, "1000": { id: "bulb" } });
    const source = await runWith(shown, (live) => live.handEdit("1000", { id: "crown" }), { "1500": { id: "sun" } });
    expect(source.document.studioEdits.captionEmojis).toEqual({ "1000": { id: "crown" }, "1500": { id: "sun" } });
  });
});

describe("Regenerate confirmation", () => {
  test("emojis this session's AI did not produce (e.g. after a reload) need a confirm; none need none", () => {
    expect(captionEmojisNeedConfirm("clip", base.studioEdits.captionEmojis)).toBe(true);
    expect(captionEmojisNeedConfirm("clip", undefined)).toBe(false);
  });
});
