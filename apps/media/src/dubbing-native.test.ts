import { describe, expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, readFile, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenDubbingRequestHash } from "@narriflow/services/dubbing-policy";
import { dubbingInputBinding } from "@narriflow/services/dubbing-input";
import { executeDubbing, type DubbingNativeRequest } from "./dubbing-native";

type Segment = { startSec: number; endSec: number; text: string };
const ffmpeg = promisify(execFile);
const DEFAULT_SEGMENTS: Segment[] = [
  { startSec: 0, endSec: 2.5, text: "First sentence" },
  { startSec: 3, endSec: 5.5, text: "Second sentence" },
  { startSec: 6, endSec: 8, text: "Third sentence" },
];
const STAGES = ["translation_intent", "translation_result", "speech_intent", "timing", "audio", "final_result"] as const;

async function input(options: { segments?: Segment[]; editedDurationSec?: number; targetLanguageCode?: "en" | "es" } = {}) {
  const request = { version: 1 as const, kind: "dubbing_request" as const, dubId: randomUUID(), workflowRunId: randomUUID(), projectId: randomUUID(), workspaceId: randomUUID(), actorUserId: randomUUID(), clipId: randomUUID(), editorRevision: 1, sourceRevision: 1,
    segments: options.segments ?? DEFAULT_SEGMENTS, editedDurationSec: options.editedDurationSec ?? 9, sourceLanguageCode: "en" as const, targetLanguageCode: options.targetLanguageCode ?? "en", voice: "marin" as const, aspectRatio: "9:16" as const,
    provider: "openai" as const, model: "gpt-4o-mini-tts", translationModel: "gpt-6-luna" };
  const value = { version: 1 as const, kind: "dub_mix" as const, request, requestHash: await frozenDubbingRequestHash(request), toolchainFingerprint: "a".repeat(64) };
  return { ...value, bindingHash: await dubbingInputBinding(value) };
}

async function tone(path: string, seconds: number, silent = false) {
  await ffmpeg("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", silent ? `anullsrc=r=24000:cl=mono:d=${seconds}` : `sine=frequency=440:duration=${seconds}`, "-c:a", "libmp3lame", path]);
}

/** Records every control operation in order and keeps checkpoint payloads. */
function recorder(overrides: { onRequest?: (value: DubbingNativeRequest) => Promise<void>; download?: (name: string, path: string) => Promise<void> } = {}) {
  const events: string[] = [], evidence = new Map<string, any>(), files = new Map<string, string>();
  let inFlight = 0, maxInFlight = 0;
  return { events, evidence, files, get maxInFlight() { return maxInFlight; },
    request: async (value: DubbingNativeRequest) => {
      inFlight++;maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        events.push(value.operation === "checkpoint" || value.operation === "publish" ? value.stage : value.operation);
        await overrides.onRequest?.(value);
        if (value.operation === "download") await overrides.download?.(value.sourceName, value.path);
        if (value.operation === "checkpoint") { evidence.set(value.stage, JSON.parse(await readFile(value.path, "utf8")));files.set(value.stage, value.path); }
        if (value.operation === "publish") files.set(value.stage, value.path);
        return {};
      } finally { inFlight--; }
    } };
}

describe("dubbing execution protocol", () => {
  test("a refusal on the second call seals one rejected result after a fresh authority per POST, and no third call", async () => {
    const work = await mkdtemp(join(tmpdir(), "dub-native-")), command = await input(), control = recorder(), posts: string[] = [];
    try {
      const result = await executeDubbing(command, { work, signal: new AbortController().signal, apiKey: "test-key", sourceNames: [], stages: ["translation_result", "speech_intent", "timing", "audio", "final_result"],
        request: control.request,
        providerRequest: async (url, options) => {
          expect(url).toBe("https://api.openai.com/v1/audio/speech");
          expect(control.events.at(-1)).toBe("authority");
          posts.push(JSON.parse(String(options.body)).input);control.events.push("POST");
          return posts.length === 1 ? new Response("mp3 bytes", { status: 200 }) : new Response("provider body is private", { status: 429 });
        } });
      expect(result).toEqual({ outcome: "rejected" });
      expect(posts).toEqual(["First sentence", "Second sentence"]);
      expect(control.events).toEqual(["translation_result", "speech_intent", "authority", "POST", "authority", "POST", "final_result"]);
      expect(control.events.filter(event => event === "authority")).toHaveLength(posts.length);
      expect(control.evidence.get("final_result")).toMatchObject({ outcome: "rejected", providerStage: "speech", httpStatus: 429 });
      expect(JSON.stringify([...control.evidence.values()])).not.toContain("provider body");
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  test("one speech intent hashes the array of every segment body", async () => {
    const work = await mkdtemp(join(tmpdir(), "dub-intent-")), command = await input(), control = recorder();
    try {
      await executeDubbing(command, { work, signal: new AbortController().signal, apiKey: "test-key", sourceNames: [], stages: ["translation_result", "speech_intent", "timing", "audio", "final_result"],
        request: control.request, providerRequest: async () => new Response(null, { status: 503 }) });
      const bodies = DEFAULT_SEGMENTS.map(segment => ({ model: "gpt-4o-mini-tts", voice: "marin", input: segment.text, response_format: "mp3" }));
      expect(control.evidence.get("speech_intent").bodySha256).toBe(createHash("sha256").update(JSON.stringify(bodies)).digest("hex"));
      expect(control.evidence.get("translation_result")).toMatchObject({ segments: DEFAULT_SEGMENTS.map(segment => segment.text), providerRequestId: null });
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  test("the first unconfirmed outcome seals unknown and stops the batch; lost intent or revoked authority never POST", async () => {
    for (const mode of ["timeout", "server", "malformed", "lost_intent", "revoked_first", "revoked_second"] as const) {
      const work = await mkdtemp(join(tmpdir(), "dub-unknown-")), command = await input();let posts = 0, authorities = 0;
      const control = recorder({ onRequest: async value => {
        if (mode === "lost_intent" && value.operation === "checkpoint" && value.stage === "speech_intent") throw Error("lost_intent_ack");
        if (value.operation === "authority" && (mode === "revoked_first" || mode === "revoked_second" && authorities === 1)) throw Error("authority_lost");
        if (value.operation === "authority") authorities++;
      } });
      try {
        const operation = () => executeDubbing(command, { work, signal: new AbortController().signal, apiKey: "test-key", sourceNames: [], stages: ["translation_result", "speech_intent", "timing", "audio", "final_result"],
          request: control.request,
          providerRequest: async () => { posts++;if (mode === "timeout") throw Error("unconfirmed");
            if (mode === "revoked_second") return new Response("mp3 bytes", { status: 200 });
            return new Response(null, { status: mode === "server" ? 503 : 200 }); } });
        if (mode === "lost_intent") { await expect(operation()).rejects.toThrow("lost_intent_ack");expect(posts).toBe(0); }
        else if (mode === "revoked_first") { await expect(operation()).rejects.toThrow("authority_lost");expect(posts).toBe(0); }
        else if (mode === "revoked_second") { await expect(operation()).rejects.toThrow("authority_lost");expect(posts).toBe(1); }
        else { expect(await operation()).toEqual({ outcome: "unknown" });expect(posts).toBe(1);expect(control.evidence.get("final_result")).toMatchObject({ outcome: "unknown", providerStage: "speech" }); }
        expect(control.evidence.has("timing")).toBe(false);
      } finally { await rm(work, { recursive: true, force: true }); }
    }
  });

  test("a translation that changes ids, order, count or leaves a line empty settles unknown before any speech", async () => {
    const bad = [
      [{ id: 2, text: "Uno" }, { id: 1, text: "Dos" }],
      [{ id: 1, text: "Uno" }],
      [{ id: 1, text: "Uno" }, { id: 2, text: "   " }],
      [{ id: 1, text: "Uno" }, { id: 3, text: "Dos" }],
    ];
    for (const segments of bad) {
      const work = await mkdtemp(join(tmpdir(), "dub-bad-translation-")), command = await input({ segments: DEFAULT_SEGMENTS.slice(0, 2), targetLanguageCode: "es" }), control = recorder();let posts = 0;
      try {
        expect(await executeDubbing(command, { work, signal: new AbortController().signal, apiKey: "test-key", sourceNames: [], stages: STAGES, request: control.request,
          providerRequest: async () => { posts++;return Response.json({ id: "resp_bad", output_text: JSON.stringify({ segments }) }); } })).toEqual({ outcome: "unknown" });
        expect(posts).toBe(1);expect(control.events).toEqual(["translation_intent", "authority", "final_result"]);
        expect(control.evidence.get("final_result")).toMatchObject({ outcome: "unknown", providerStage: "translation" });
      } finally { await rm(work, { recursive: true, force: true }); }
    }
  });

  test("narration that cannot fit seals unfit with the segment index and publishes nothing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dub-unfit-")), speech = join(directory, "long.mp3");
    try {
      await tone(speech, 3);
      const command = await input({ segments: [{ startSec: 0, endSec: 1, text: "A very long translated line" }], editedDurationSec: 1 }), control = recorder();let posts = 0;
      const result = await executeDubbing(command, { work: await mkdtemp(join(directory, "work-")), signal: new AbortController().signal, apiKey: "test-key", sourceNames: [], stages: STAGES, request: control.request,
        providerRequest: async () => { posts++;return new Response(await readFile(speech), { headers: { "Content-Type": "audio/mpeg" } }); } });
      expect(result).toEqual({ outcome: "unfit" });expect(posts).toBe(1);
      expect(control.events).toEqual(["translation_result", "speech_intent", "authority", "final_result"]);
      expect(control.evidence.get("final_result")).toMatchObject({ outcome: "unfit", segmentIndex: 0 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  test("a clip that trims to nothing settles unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dub-silent-")), speech = join(directory, "silent.mp3");
    try {
      await tone(speech, 1, true);
      const command = await input({ segments: [{ startSec: 0, endSec: 3, text: "Silence" }], editedDurationSec: 4 }), control = recorder();
      const result = await executeDubbing(command, { work: await mkdtemp(join(directory, "work-")), signal: new AbortController().signal, apiKey: "test-key", sourceNames: [], stages: STAGES, request: control.request,
        providerRequest: async () => new Response(await readFile(speech), { headers: { "Content-Type": "audio/mpeg" } }) });
      expect(result).toEqual({ outcome: "unknown" });
      expect(control.evidence.get("final_result")).toMatchObject({ outcome: "unknown", providerStage: "speech" });
      expect(control.evidence.has("timing")).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  test("real translated speech is placed, timed and mixed once, and sealed recovery never POSTs again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dub-real-")), speech = join(directory, "fixture.mp3");
    await tone(speech, 1.2);
    const segments = DEFAULT_SEGMENTS.slice(0, 2), command = await input({ segments, editedDurationSec: 6, targetLanguageCode: "es" }), posts: string[] = [], spoken: string[] = [];
    const translated = ["Hola mundo", "Adios, amigo."];
    let concurrent = 0, maxConcurrent = 0;
    const server = Bun.serve({ port: 0, fetch: async request => {
      const path = new URL(request.url).pathname;posts.push(path);
      const body = await request.json();
      if (path === "/v1/responses") {
        expect(body.model).toBe("gpt-6-luna");
        expect(body.text.format).toMatchObject({ type: "json_schema", name: "dub_translation", strict: true });
        expect(body.text.format.schema.properties.segments.items.required).toEqual(["id", "text"]);
        const lines = JSON.parse(String(body.input[1].content).split("LINES:\n")[1]);
        expect(lines).toEqual([{ id: 1, text: "First sentence", seconds: 2.5 }, { id: 2, text: "Second sentence", seconds: 2.5 }]);
        expect(body.input[0].content).toContain("speakable within its seconds");
        return Response.json({ id: "resp_controlled", output_text: JSON.stringify({ segments: translated.map((text, index) => ({ id: index + 1, text })) }) });
      }
      concurrent++;maxConcurrent = Math.max(maxConcurrent, concurrent);spoken.push(body.input);
      try { await Bun.sleep(15);return new Response(await readFile(speech), { headers: { "Content-Type": "audio/mpeg" } }); } finally { concurrent--; }
    } });
    try {
      const control = recorder({ onRequest: async value => { if (value.operation === "download") throw Error("a first attempt downloads nothing"); } });
      const first = await mkdtemp(join(directory, "first-"));
      const result = await executeDubbing(command, { work: first, signal: new AbortController().signal, apiKey: "test-key", sourceNames: [], stages: STAGES, request: control.request,
        providerRequest: (url, options) => { expect(control.events.at(-1)).toBe("authority");control.events.push("POST");return fetch(new URL(new URL(url).pathname, server.url), { method: "POST", headers: options.headers, body: String(options.body), signal: options.signal }); } });
      expect(result).toEqual({ outcome: "completed" });
      expect(posts).toEqual(["/v1/responses", "/v1/audio/speech", "/v1/audio/speech"]);expect(spoken).toEqual(translated);expect(maxConcurrent).toBe(1);expect(control.maxInFlight).toBe(1);
      expect(control.events).toEqual(["translation_intent", "authority", "POST", "translation_result", "speech_intent", "authority", "POST", "authority", "POST", "timing", "audio", "final_result"]);
      expect(control.evidence.get("translation_result")).toMatchObject({ segments: translated, providerRequestId: "resp_controlled" });
      const timing = control.evidence.get("timing") as { segments: Array<{ startSec: number; endSec: number; tempo: number; words: Array<{ text: string; spaceBefore: boolean; startSec: number; endSec: number }> }> };
      expect(timing.segments).toHaveLength(2);
      for (const [index, placed] of timing.segments.entries()) {
        expect(placed.startSec).toBeGreaterThanOrEqual(segments[index]!.startSec);expect(placed.startSec).toBeLessThanOrEqual(segments[index]!.startSec + 0.6);
        expect(placed.tempo).toBe(1);expect(placed.endSec).toBeGreaterThan(placed.startSec);expect(placed.endSec).toBeLessThanOrEqual(6);
        expect(placed.words[0]!.startSec).toBe(placed.startSec);expect(placed.words.at(-1)!.endSec).toBe(placed.endSec);
      }
      expect(timing.segments[0]!.words.map(word => word.text)).toEqual(["Hola", "mundo"]);expect(timing.segments[1]!.words.map(word => word.text)).toEqual(["Adios,", "amigo."]);
      const final = control.evidence.get("final_result") as { audio: object; video?: unknown; probe: { state: string; durationSec: number } };
      const bytes = await readFile(control.files.get("audio")!);
      expect(final.audio).toEqual({ byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });expect(final.video).toBeUndefined();
      expect(final.probe.state).toBe("ready");expect(final.probe.durationSec).toBeGreaterThan(5.9);expect(final.probe.durationSec).toBeLessThan(6.2);

      // Sealed timing and audio: only the final result is sealed again.
      const sealed: Record<string, string> = { dub_timing: control.files.get("timing")!, dub_audio: control.files.get("audio")! };
      const recovery = recorder({ download: async (name, path) => { await copyFile(sealed[name]!, path); } });
      expect(await executeDubbing(command, { work: await mkdtemp(join(directory, "recovered-")), signal: new AbortController().signal, sourceNames: ["dub_timing", "dub_audio"], stages: ["final_result"], request: recovery.request,
        providerRequest: async () => { throw Error("sealed recovery must not call a provider"); } })).toEqual({ outcome: "completed" });
      expect(recovery.events).toEqual(["download", "download", "final_result"]);
      expect(recovery.evidence.get("final_result")).toMatchObject({ outcome: "completed", audio: final.audio });
      expect(posts).toHaveLength(3);

      // A sealed translation only: speech is voiced from it, and no translation call is made.
      const translation = recorder({ download: async (_name, path) => { await copyFile(control.files.get("translation_result")!, path); } });
      const spokenBefore = spoken.length;
      expect(await executeDubbing(command, { work: await mkdtemp(join(directory, "translated-")), signal: new AbortController().signal, apiKey: "test-key", sourceNames: ["translation_result"], stages: ["speech_intent", "timing", "audio", "final_result"],
        request: translation.request, providerRequest: (url, options) => fetch(new URL(new URL(url).pathname, server.url), { method: "POST", headers: options.headers, body: String(options.body), signal: options.signal }) })).toEqual({ outcome: "completed" });
      expect(translation.events).toEqual(["download", "speech_intent", "authority", "authority", "timing", "audio", "final_result"]);
      expect(spoken.slice(spokenBefore)).toEqual(translated);expect(posts.filter(path => path === "/v1/responses")).toHaveLength(1);
    } finally { server.stop(true);await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  test("a recovered audio without its sealed timing is refused before any work", async () => {
    const work = await mkdtemp(join(tmpdir(), "dub-no-timing-")), command = await input();
    try {
      await expect(executeDubbing(command, { work, signal: new AbortController().signal, sourceNames: ["dub_audio"], stages: ["final_result"], request: async () => ({}) })).rejects.toThrow("dubbing_command_invalid");
    } finally { await rm(work, { recursive: true, force: true }); }
  });
});
