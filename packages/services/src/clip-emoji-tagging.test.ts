import { describe, expect, test } from "bun:test";
import { CAPTION_EMOJI_AI_BADGES, CAPTION_EMOJI_AI_GLYPHS } from "@narriflow/caption-emoji/index";
import { DEFAULT_CAPTION_PRESET, EDITOR_DOCUMENT_VERSION, editorDocumentSchema, type EditorDocument, type TranscriptUtterance, type TranscriptWord } from "@narriflow/validators";
import { EMOJI_TAGGING_SYSTEM_PROMPT, tagCaptionEmojis, type CaptionEmojiTaggingConfig } from "./clip-emoji-tagging";
import { clipEmojiSuggestionFailure, suggestClipEmojis, type ClipEmojiTagger } from "./clip-emoji-suggestion";

const w = (startSec: number, text: string): TranscriptWord => ({ word: text, startSec, endSec: startSec + 0.2, confidence: null });
/** `count` utterances of 500 words (sentences of 10), so each is its own chunk. */
const utterances = (count: number): TranscriptUtterance[] => Array.from({ length: count }, (_, i) => ({
  index: i, speaker: 0, speakerLabel: "S", startSec: i * 200, endSec: i * 200 + 100, text: "x", confidence: null,
  words: Array.from({ length: 500 }, (_, k) => w(i * 200 + k * 0.3, k % 10 === 9 ? "word." : "word")),
}));

function sse(report: unknown, tokens = 120, text = JSON.stringify(report)): Response {
  const completed = { type: "response.completed", response: { status: "completed", usage: { total_tokens: tokens },
    output: [{ type: "message", content: [{ type: "output_text", text }] }] } };
  const body = `event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify(completed)}\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function config(fetchImpl: CaptionEmojiTaggingConfig["fetch"], overrides: Partial<CaptionEmojiTaggingConfig> = {}): CaptionEmojiTaggingConfig {
  let clock = 0;
  return { apiKey: "k", concurrency: 2, fetch: fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; }, ...overrides };
}

describe("tagCaptionEmojis", () => {
  test("maps the model's ids and glyphs to Word Keys and catalog refs", async () => {
    const outcome = await tagCaptionEmojis({ utterances: utterances(1), languageCode: "en", deadline: 60_000 }, config(async () =>
      sse({ serious: [], picks: [{ k: 4, w: "word", p: "yes", e: "😂", s: 3 }, { k: 17, w: "word", p: "yes", e: "🔥", s: 2 }, { k: 8, w: "word", p: "yes", e: "🇯🇵", s: 3 }, { k: 999, w: "word", p: "yes", e: "😂", s: 2 }] })));
    expect(outcome.picks).toEqual([{ key: "1200", ref: { id: "laugh-tears", word: "word" }, strength: 3 }, { key: "5100", ref: { id: "flame", word: "word" }, strength: 2 }]);
    expect(outcome).toMatchObject({ chunks: 1, tagged: 1, failed: 0, tokensUsed: 120 });
  });

  test("a pick the model marks absent is dropped and the run still counts as tagged", async () => {
    const outcome = await tagCaptionEmojis({ utterances: utterances(1), languageCode: "en", deadline: 60_000 }, config(async () =>
      sse({ serious: [], picks: [{ k: 4, w: "word", p: "no", e: "📷", s: 3 }, { k: 17, w: "word", p: "if", e: "🔥", s: 2 }, { k: 24, w: "word", p: "no", e: "😂", s: 3 }] })));
    expect(outcome.picks).toEqual([{ key: "5100", ref: { id: "flame", word: "word" }, strength: 2 }]);
    expect(outcome).toMatchObject({ tagged: 1, failed: 0, retried: 0 });
  });

  test("every design is offered: each single emoji, and each badge with its name; a badge pick maps to the badge, never with a tone", async () => {
    expect(CAPTION_EMOJI_AI_GLYPHS).toHaveLength(1012);
    expect(CAPTION_EMOJI_AI_BADGES).toHaveLength(400);
    for (const badge of CAPTION_EMOJI_AI_BADGES) expect(EMOJI_TAGGING_SYSTEM_PROMPT).toContain(`${badge.glyph} ${badge.name}`);
    const outcome = await tagCaptionEmojis({ utterances: utterances(1), languageCode: "en", deadline: 60_000 }, config(async () =>
      sse({ serious: [], picks: [{ k: 4, w: "word", p: "yes", e: "🤑", s: 3 }, { k: 17, w: "word", p: "yes", e: "☕⏰", s: 3 }, { k: 24, w: "word", p: "yes", e: "👋🏿", s: 3 }] })));
    expect(outcome.picks).toEqual([
      { key: "1200", ref: { id: "money-mouth", word: "word" }, strength: 3 },
      { key: "5100", ref: { id: "morning-coffee", word: "word" }, strength: 3 },
      { key: "7200", ref: { id: "waving-hand", word: "word" }, strength: 3 },
    ]);
  });

  test("sends the constant vocabulary prompt first, the keyed words last, with gpt-6-luna and low reasoning", async () => {
    const bodies: { model: string; reasoning: unknown; input: { role: string; content: string }[]; text: { format: { name: string; strict: boolean } } }[] = [];
    await tagCaptionEmojis({ utterances: utterances(2), languageCode: "ur", title: "شادی", deadline: 60_000 }, config(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return sse({ serious: [], picks: [] });
    }));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "low" }, text: { format: { name: "caption_emojis", strict: true } } });
      expect(body.input[0]).toEqual({ role: "system", content: EMOJI_TAGGING_SYSTEM_PROMPT });
      expect(body.input[1]!.content.startsWith("Title: شادی\nLanguage: ur\nTokens:\n")).toBe(true);
    }
    expect(CAPTION_EMOJI_AI_GLYPHS.every((glyph) => EMOJI_TAGGING_SYSTEM_PROMPT.includes(glyph))).toBe(true);
  });

  test("a chunk that fails twice yields no picks and the others still count; it never throws", async () => {
    let call = 0;
    const outcome = await tagCaptionEmojis({ utterances: utterances(3), languageCode: "en", deadline: 60_000 }, config(async () => {
      call++;
      if (call === 1) throw new TypeError("network");
      if (call <= 4) return new Response("nope", { status: 500 });
      return sse({ serious: [], picks: [{ k: 0, w: "word", p: "yes", e: "😂", s: 3 }] });
    }, { concurrency: 1 }));
    expect(call).toBe(5);
    expect(outcome).toMatchObject({ chunks: 3, tagged: 1, failed: 2, retried: 2, rateLimited: 0 });
    expect(outcome.picks.map((pick) => pick.key)).toEqual(["400000"]);
  });

  test("a chunk that fails once (`response.failed`, or text that is not JSON) is sent again and tagged", async () => {
    const failedEvent = () => new Response(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", usage: { total_tokens: 30 } } })}\n\n`, { status: 200 });
    for (const first of [failedEvent, () => sse(null, 40, "We need output in JSON with picks")]) {
      let calls = 0;
      const outcome = await tagCaptionEmojis({ utterances: utterances(1), languageCode: "en", deadline: 60_000 }, config(async () => {
        calls++;
        return calls === 1 ? first() : sse({ serious: [], picks: [{ k: 4, w: "word", p: "yes", e: "😂", s: 3 }] });
      }));
      expect(calls).toBe(2);
      expect(outcome).toMatchObject({ chunks: 1, tagged: 1, failed: 0, retried: 1 });
      expect(outcome.picks).toEqual([{ key: "1200", ref: { id: "laugh-tears", word: "word" }, strength: 3 }]);
    }
  });

  test("no retry when the deadline is too near for another request", async () => {
    let clock = 0;
    let calls = 0;
    // The first request takes 52 s of a 60 s deadline: 8 s are left, the request reserve is 5 s, so the
    // retry is sent; at 56 s only 4 s are left and it is not.
    for (const [spent, expected] of [[52_000, 2], [56_000, 1]] as const) {
      clock = 0;
      calls = 0;
      const outcome = await tagCaptionEmojis({ utterances: utterances(1), languageCode: "en", deadline: 60_000 }, config(async () => {
        calls++;
        clock += spent;
        return new Response("nope", { status: 500 });
      }, { now: () => clock }));
      expect(calls).toBe(expected);
      expect(outcome).toMatchObject({ tagged: 0, failed: 1, retried: expected - 1 });
    }
  });

  test("no second retry after a 429: the request already retried it", async () => {
    let calls = 0;
    const outcome = await tagCaptionEmojis({ utterances: utterances(1), languageCode: "en", deadline: 60_000 }, config(async () => {
      calls++;
      return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    }));
    // The request's own wait-and-retry, then nothing more.
    expect(calls).toBe(2);
    expect(outcome).toMatchObject({ tagged: 0, failed: 1, retried: 0, rateLimited: 1 });
  });

  test("a 429 with no time to retry counts as rate limited", async () => {
    const outcome = await tagCaptionEmojis({ utterances: utterances(1), languageCode: "en", deadline: 12_000 }, config(async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "5" } })));
    expect(outcome).toMatchObject({ tagged: 0, failed: 1, rateLimited: 1, picks: [] });
  });

  test("no key, a past deadline or an aborted signal sends nothing", async () => {
    let calls = 0;
    const counting = async () => { calls++; return sse({ serious: [], picks: [] }); };
    expect(await tagCaptionEmojis({ utterances: utterances(2), languageCode: "en", deadline: 60_000 }, config(counting, { apiKey: " " })))
      .toMatchObject({ chunks: 2, skipped: 2, picks: [] });
    expect(await tagCaptionEmojis({ utterances: utterances(2), languageCode: "en", deadline: 4_000 }, config(counting))).toMatchObject({ skipped: 2 });
    expect(await tagCaptionEmojis({ utterances: utterances(2), languageCode: "en", deadline: 60_000, signal: AbortSignal.abort() }, config(counting))).toMatchObject({ skipped: 2 });
    expect(calls).toBe(0);
  });

  test("a cut-off reply, text that is not JSON, a report of another shape or one whose picks name no word is a failed chunk, sent once more", async () => {
    const replies = [
      () => new Response("event: response.created\ndata: {}\n\n", { status: 200 }),
      () => sse("not json"),
      () => sse({ unexpected: true }),
      // No "serious" list: its picks cannot be checked against serious passages (a 🎉 landed on "hospital").
      () => sse({ picks: [{ k: 4, w: "word", p: "yes", e: "🎉", s: 3 }] }),
      // A pick without "p" cannot be checked for negation.
      () => sse({ serious: [], picks: [{ k: 4, w: "word", e: "😂", s: 3 }] }),
      // Every pick names a word the chunk does not have at that id: nothing was tagged.
      () => sse({ serious: [], picks: [{ k: 164, w: "flashlight.", p: "yes", e: "🔦", s: 3 }, { k: 4, w: "hospital", p: "yes", e: "🎉", s: 3 }] }),
    ];
    for (const reply of replies) {
      let calls = 0;
      const tag: ClipEmojiTagger = (input) => tagCaptionEmojis(input, config(async () => { calls++; return reply(); }));
      const suggestion = await suggestClipEmojis({ document: documentOf(utterances(1)), languageCode: "en", title: null, density: "balanced", deadline: 60_000 }, tag);
      expect(calls).toBe(2);
      expect(suggestion.outcome).toMatchObject({ chunks: 1, tagged: 0, failed: 1, retried: 1, rateLimited: 0, picks: [] });
      expect(suggestion).toMatchObject({ emojis: {}, complete: false });
      expect(clipEmojiSuggestionFailure(suggestion.outcome)).toBe("clip_emoji_suggestion_failed");
    }
  });

  test("a valid report on the retry counts as tagged", async () => {
    let calls = 0;
    const outcome = await tagCaptionEmojis({ utterances: utterances(1), languageCode: "en", deadline: 60_000 }, config(async () =>
      ++calls === 1 ? sse({ picks: [{ k: 4, w: "word", p: "yes", e: "😂", s: 3 }] }) : sse({ serious: [], picks: [{ k: 4, w: "word", p: "yes", e: "😂", s: 3 }] })));
    expect(outcome).toMatchObject({ tagged: 1, failed: 0, retried: 1, picks: [{ key: "1200", ref: { id: "laugh-tears", word: "word" }, strength: 3 }] });
  });

  test("a run is complete only when every chunk was tagged; a partial run keeps what was tagged", async () => {
    let call = 0;
    const tag: ClipEmojiTagger = (input) => tagCaptionEmojis(input, config(async () =>
      ++call === 1 ? sse({ serious: [], picks: [{ k: 4, w: "word", p: "yes", e: "😂", s: 3 }] }) : sse({ unexpected: true }), { concurrency: 1 }));
    const partial = await suggestClipEmojis({ document: documentOf(utterances(2)), languageCode: "en", title: null, density: "balanced", deadline: 60_000 }, tag);
    expect(partial.outcome).toMatchObject({ chunks: 2, tagged: 1, failed: 1, retried: 1 });
    expect(partial).toMatchObject({ emojis: { "1200": { id: "laugh-tears" } }, complete: false });
    expect(clipEmojiSuggestionFailure(partial.outcome)).toBeNull();
    const full = await suggestClipEmojis({ document: documentOf(utterances(1)), languageCode: "en", title: null, density: "balanced", deadline: 60_000 },
      (input) => tagCaptionEmojis(input, config(async () => sse({ serious: [], picks: [] }))));
    expect(full).toMatchObject({ emojis: {}, complete: true });
  });
});

/** A clip whose transcript is `slice`, whole and uncut. */
function documentOf(slice: TranscriptUtterance[]): EditorDocument {
  return editorDocumentSchema.parse({ version: EDITOR_DOCUMENT_VERSION, clipStartSec: 0, clipEndSec: slice.at(-1)!.endSec + 60, captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: slice, studioEdits: {}, brollUrl: null, deletedRanges: [], sceneBlocks: [], censorSegments: [], mediaMotions: [] });
}
