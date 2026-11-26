import { describe, expect, test } from "bun:test";
import { FILLER_TAG_MAX_KEYS, fillerWordKey, type TranscriptUtterance, type TranscriptWord } from "@narriflow/validators";
import { tagTranscriptFillers, type FillerTaggingConfig } from "./clip-filler-tagging";
import { TAGGING_REQUEST_DEFAULTS } from "./transcript-tagging-request";

const w = (startSec: number, text: string): TranscriptWord => ({ word: text, startSec, endSec: startSec + 0.2, confidence: null });
const utterances = (count: number, filler = (k: number) => k === 5): TranscriptUtterance[] => Array.from({ length: count }, (_, i) => ({
  index: i, speaker: 0, speakerLabel: "S", startSec: i * 100, endSec: i * 100 + 60, text: "x", confidence: null,
  // 200 words per utterance (sentences of 9 words) so every utterance becomes its own chunk(s).
  words: Array.from({ length: 200 }, (_, k) => w(i * 100 + k * 0.3, filler(k) ? "äh," : `wort${k % 9 === 8 ? "." : ""}`)),
}));

/** A streamed Responses reply, split into arbitrary byte pieces like a real network. */
function sse(events: { event: string; data: unknown }[], pieces = 7): Response {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / pieces);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
    controller.close();
  } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}
/** A raw server-sent-event body, split into `pieces` byte pieces. */
function raw(text: string, pieces = 5): Response {
  const bytes = new TextEncoder().encode(text), size = Math.ceil(bytes.length / pieces);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
    controller.close();
  } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}
const completed = (fillers: unknown[], tokens = 100) => ({ type: "response.completed", response: { status: "completed", usage: { total_tokens: tokens },
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ fillers }) }] }] } });
const ok = (fillers: unknown[], tokens = 100) => sse([
  { event: "response.created", data: { type: "response.created", response: { status: "in_progress" } } },
  { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "{\"fill" } },
  { event: "response.completed", data: completed(fillers, tokens) },
]);
const hesitation = (id: number, text = "äh") => ({ id, text, is_dictionary_word: false, kind: "hesitation_sound" });

function config(fetchImpl: FillerTaggingConfig["fetch"], overrides: Partial<FillerTaggingConfig> = {}): FillerTaggingConfig {
  let clock = 0;
  return { apiKey: "k", models: [{ model: "luna", reasoningEffort: "low" }], deadline: 60_000, concurrency: 2, maxOutputTokens: 4000,
    fetch: fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; }, ...overrides };
}

describe("tagTranscriptFillers", () => {
  test("tags the filler the model accepts, keyed by source identity", async () => {
    const outcome = await tagTranscriptFillers(utterances(1), "de", config(async () => ok([hesitation(5)])));
    expect(outcome.keys).toEqual([fillerWordKey(0, w(1.5, "äh,"))]);
    expect(outcome.tagged).toBe(outcome.chunks);
    expect(outcome.tokensUsed).toBe(100 * outcome.chunks);
    expect(outcome.overflow).toBe(false);
    expect(outcome.contract.promptSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("a lost response is never retried; the chunk is simply untagged", async () => {
    let calls = 0;
    const outcome = await tagTranscriptFillers(utterances(1), "de", config(async () => { calls++; throw new TypeError("network"); }));
    expect(calls).toBe(outcome.chunks);
    expect(outcome).toMatchObject({ failed: outcome.chunks, keys: [] });
  });

  test("a rate-limit 429 is retried once, honouring Retry-After", async () => {
    const replies = [new Response("{}", { status: 429, headers: { "retry-after": "2" } }), ok([hesitation(5)])];
    let clock = 0;
    const one = [{ ...utterances(1)[0]!, words: utterances(1)[0]!.words.slice(0, 50) }];
    const outcome = await tagTranscriptFillers(one, "de", config(async () => replies.shift()!, { concurrency: 1, now: () => clock, sleep: async (ms) => { clock += ms; } }));
    expect(clock).toBe(2000);
    expect(outcome.keys).toHaveLength(1);
  });

  test("a quota 429, a 5xx, or a Retry-After that does not fit is not retried", async () => {
    for (const [reply, deadline] of [
      [() => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 }), 60_000],
      [() => new Response("{}", { status: 500 }), 60_000],
      [() => new Response("{}", { status: 429, headers: { "retry-after": "55" } }), 60_000],
    ] as const) {
      let calls = 0;
      const one = [{ ...utterances(1)[0]!, words: utterances(1)[0]!.words.slice(0, 50) }];
      const outcome = await tagTranscriptFillers(one, "de", config(async () => { calls++; return reply(); }, { deadline }));
      expect(calls).toBe(1);
      expect(outcome.failed).toBe(1);
    }
  });

  test("incomplete, failed, truncated, oversized or malformed streams fail their chunk only", async () => {
    const huge = "x".repeat(TAGGING_REQUEST_DEFAULTS.maxResponseBytes + 10);
    for (const reply of [
      () => sse([{ event: "response.incomplete", data: { type: "response.incomplete", response: { status: "incomplete" } } }]),
      () => sse([{ event: "response.failed", data: { type: "response.failed", response: { status: "failed" } } }]),
      () => sse([{ event: "error", data: { type: "error", message: "boom" } }]),
      () => sse([{ event: "response.created", data: { type: "response.created" } }]), // cut off before completion
      () => sse([{ event: "response.completed", data: { type: "response.completed", response: { status: "completed", output: [{ content: [{ text: "{bad" }] }] } } }]),
      () => sse([{ event: "response.output_text.delta", data: { delta: huge } }, { event: "response.completed", data: completed([hesitation(5)]) }]),
      () => new Response("not a stream", { status: 200 }),
      () => new Response("{}", { status: 400 }),
    ]) {
      const outcome = await tagTranscriptFillers(utterances(1), "de", config(async () => reply()));
      expect(outcome.keys).toEqual([]);
      expect(outcome.failed).toBe(outcome.chunks);
    }
  });

  test("server-sent events are read strictly: malformed terminal evidence fails closed (Sol v3)", async () => {
    const P = JSON.stringify(completed([hesitation(5)]));
    const failing = [
      `event: response.completed\ndata: {broken\ndata: ${P}\n\n`, // one event's data is the two lines joined: not JSON
      `event: response.failed\ndata: ${P}\n\n`, // event name and payload type disagree
      `data: ${P}\n\n`, // no event name
      `event: response.completed\ndata: ${P}`, // unfinished at end of stream
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "in_progress" } })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ ...completed([hesitation(5)]), padding: "x".repeat(TAGGING_REQUEST_DEFAULTS.maxLineBytes + 1) })}\n\n`,
    ];
    for (const text of failing) {
      const outcome = await tagTranscriptFillers(utterances(1), "de", config(async () => raw(text)));
      expect(outcome.keys).toEqual([]);
      expect(outcome.failed).toBe(outcome.chunks);
    }
    const accepted = [
      `event: response.completed\r\ndata: ${P}\r\n\r\n`, // CRLF
      `: keep-alive\n\ndata: ${P}\nevent: response.completed\n\n`, // comment; data before the event line
      // JSON data split over two data lines (rejoined with a newline, which JSON allows between tokens).
      `event: response.completed\ndata: ${P.replace('"response":', '"response":\ndata: ')}\n\n`,
      `event: response.completed\ndata: ${P}\n\nevent: response.failed\n`, // reading stops at the first terminal event
    ];
    for (const text of accepted) {
      const outcome = await tagTranscriptFillers(utterances(1), "de", config(async () => raw(text, 3)));
      expect(outcome.keys).toEqual([fillerWordKey(0, w(1.5, "äh,"))]);
    }
  });

  test("a stream that errors mid-body fails its chunk", async () => {
    const broken = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("event: response.created\n")); c.error(new Error("reset")); } }), { status: 200 });
    const outcome = await tagTranscriptFillers(utterances(1), "de", config(async () => broken()));
    expect(outcome.failed).toBe(outcome.chunks);
  });

  test("tokens are counted even when the response is unusable", async () => {
    const outcome = await tagTranscriptFillers(utterances(1), "de", config(async () =>
      sse([{ event: "response.incomplete", data: { type: "response.incomplete", response: { status: "incomplete", usage: { total_tokens: 7 } } } }])));
    expect(outcome.tokensUsed).toBe(7 * outcome.chunks);
  });

  test("chunks that cannot start before the deadline are skipped", async () => {
    let clock = 0;
    const outcome = await tagTranscriptFillers(utterances(6), "de", config(async () => { clock += 20_000; return ok([]); }, { concurrency: 1, now: () => clock }));
    expect(outcome.skipped).toBeGreaterThan(0);
    expect(outcome.tagged + outcome.skipped).toBe(outcome.chunks);
  });

  test("with two models, only tokens both accept count", async () => {
    const fetchImpl: FillerTaggingConfig["fetch"] = async (_url, init) => {
      const model = JSON.parse(String(init!.body)).model;
      return ok(model === "luna" ? [hesitation(5), { ...hesitation(6), text: "wort" }] : [hesitation(5)]);
    };
    const outcome = await tagTranscriptFillers(utterances(1), "de", config(fetchImpl, { models: [{ model: "luna", reasoningEffort: "low" }, { model: "second", reasoningEffort: "none" }] }));
    expect(outcome.keys).toEqual([fillerWordKey(0, w(1.5, "äh,"))]);
    expect(outcome.contract.models).toHaveLength(2);
  });

  test("with two models, one model failing fails the chunk", async () => {
    const fetchImpl: FillerTaggingConfig["fetch"] = async (_url, init) => JSON.parse(String(init!.body)).model === "luna" ? ok([hesitation(5)]) : new Response("{}", { status: 500 });
    const outcome = await tagTranscriptFillers(utterances(1), "de", config(fetchImpl, { models: [{ model: "luna", reasoningEffort: "low" }, { model: "second", reasoningEffort: "none" }] }));
    expect(outcome.keys).toEqual([]);
    expect(outcome.failed).toBe(outcome.chunks);
  });

  test("never has more requests in flight than the concurrency", async () => {
    let inFlight = 0, peak = 0;
    const outcome = await tagTranscriptFillers(utterances(12), "de", config(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--; return ok([]);
    }, { concurrency: 4, models: [{ model: "a", reasoningEffort: "low" }, { model: "b", reasoningEffort: "low" }] }));
    expect(outcome.tagged).toBe(outcome.chunks);
    expect(peak).toBe(4);
  });

  test("a cap below the model count runs the models one after another (Sol v3)", async () => {
    let inFlight = 0, peak = 0;
    const one = [{ ...utterances(1)[0]!, words: utterances(1)[0]!.words.slice(0, 50) }];
    const outcome = await tagTranscriptFillers(one, "de", config(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--; return ok([hesitation(5)]);
    }, { concurrency: 1, models: [{ model: "a", reasoningEffort: "low" }, { model: "b", reasoningEffort: "low" }] }));
    expect(peak).toBe(1);
    expect(outcome.keys).toHaveLength(1);
  });

  test("line and error-body caps count bytes, not characters (Sol v4)", async () => {
    const P = JSON.stringify(completed([hesitation(5)]));
    const wide = `:${"あ".repeat(100_000)}\n\nevent: response.completed\ndata: ${P}\n\n`; // 300,001-byte comment line
    const outcome = await tagTranscriptFillers(utterances(1), "de", config(async () => raw(wide, 1)));
    expect(outcome.keys).toEqual([]);
    // A quota marker past the 64 KiB inspected prefix is not seen, so the one retry happens.
    const one = [{ ...utterances(1)[0]!, words: utterances(1)[0]!.words.slice(0, 50) }];
    const replies = [new Response(`${"x".repeat(1024 * 1024)}insufficient_quota`, { status: 429, headers: { "retry-after": "1" } }), ok([hesitation(5)])];
    let calls = 0;
    const retried = await tagTranscriptFillers(one, "de", config(async () => { calls++; return replies.shift()!; }));
    expect(calls).toBe(2);
    expect(retried.keys).toHaveLength(1);
  });

  test("a 429 error body is read only up to a bound", async () => {
    let pulled = 0;
    const endless = () => new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(16 * 1024)); } }), { status: 429, headers: { "retry-after": "55" } });
    const one = [{ ...utterances(1)[0]!, words: utterances(1)[0]!.words.slice(0, 50) }];
    const outcome = await tagTranscriptFillers(one, "de", config(async () => endless()));
    expect(outcome.failed).toBe(1);
    expect(pulled).toBeLessThan(10);
  });

  test("more tags than can be frozen keeps none", async () => {
    // Every word a distinct filler token, across enough chunks to exceed the cap.
    const count = Math.ceil((FILLER_TAG_MAX_KEYS + 1) / 200);
    const many = utterances(count, () => true).map((u, i) => ({ ...u, words: u.words.map((word, k) => ({ ...word, word: "äh", startSec: i * 100 + k * 0.3, endSec: i * 100 + k * 0.3 + 0.2 })) }));
    const outcome = await tagTranscriptFillers(many, "de", config(async (_url, init) => {
      const prompt = JSON.parse(String(init!.body)).input[1].content as string;
      const ids = [...prompt.matchAll(/(\d+):äh/g)].map((m) => Number(m[1]));
      return ok(ids.map((id) => hesitation(id)));
    }, { concurrency: 8 }));
    expect(outcome.overflow).toBe(true);
    expect(outcome.keys).toEqual([]);
  });

  test("no API key tags nothing and sends nothing", async () => {
    let calls = 0;
    const outcome = await tagTranscriptFillers(utterances(1), "de", config(async () => { calls++; return ok([]); }, { apiKey: " " }));
    expect(calls).toBe(0);
    expect(outcome.skipped).toBe(outcome.chunks);
  });

  test("an unsafe chunk is never sent", async () => {
    let calls = 0;
    const unsafe = [{ ...utterances(1)[0]!, words: [w(0, "hola"), w(0.3, "x y"), w(0.6, "eh")] }];
    const outcome = await tagTranscriptFillers(unsafe, "es", config(async () => { calls++; return ok([]); }));
    expect(calls).toBe(0);
    expect(outcome).toMatchObject({ chunks: 1, unsafe: 1, keys: [] });
  });

  test("the request streams the frozen prompt, schema and model settings", async () => {
    let body: any;
    await tagTranscriptFillers(utterances(1), "ur", config(async (_url, init) => { body = JSON.parse(String(init!.body)); return ok([]); }));
    expect(body).toMatchObject({ model: "luna", reasoning: { effort: "low" }, stream: true, store: false, max_output_tokens: 4000 });
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true, name: "fillers" });
    expect(body.input[1].content.startsWith("Language: ur\nTokens:\nS0: 0:")).toBe(true);
  });
});
