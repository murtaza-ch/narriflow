import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, copyFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenDubbingRequestHash } from "@narriflow/services/dubbing-policy";
import { dubbingInputBinding } from "@narriflow/services/dubbing-input";
import { executeDubbing } from "./dubbing-native";

async function input(byteLength = 3, targetLanguageCode: "en" | "es" = "en") {
  const request = { version: 1 as const, kind: "dubbing_request" as const, dubId: randomUUID(), workflowRunId: randomUUID(), projectId: randomUUID(), workspaceId: randomUUID(), actorUserId: randomUUID(), clipId: randomUUID(), editorRevision: 1, sourceRevision: 1,
    baseRender: { id: randomUUID(), storageKey: "projects/frozen/render.mp4", byteLength, durationSec: 2 }, script: "A frozen script", sourceLanguageCode: "en" as const, targetLanguageCode, voice: "marin" as const, aspectRatio: "9:16" as const,
    provider: "openai" as const, model: "gpt-4o-mini-tts", translationModel: "gpt-5.4-mini" };
  const value = { version: 1 as const, kind: "dub_mix" as const, request, requestHash: await frozenDubbingRequestHash(request), toolchainFingerprint: "a".repeat(64), baseVideo: { storageKey: request.baseRender.storageKey, etag: '"base"', byteLength } };
  return { ...value, bindingHash: await dubbingInputBinding(value) };
}

test("a known provider refusal seals one typed result after an acknowledged intent and fresh authority, without retrying", async () => {
  const work = await mkdtemp(join(tmpdir(), "dub-native-")), command = await input(), events: string[] = [], checkpoints: unknown[] = [];
  try {
    const result = await executeDubbing(command, { work, signal: new AbortController().signal, apiKey: "test-key", sourceNames: ["base_video"], stages: ["translation_result", "speech_intent", "audio", "video", "final_result"],
      request: async value => {
        events.push(value.operation === "checkpoint" ? value.stage : value.operation);
        if (value.operation === "download") await writeFile(value.path, "abc");
        if (value.operation === "checkpoint") checkpoints.push(JSON.parse(await readFile(value.path, "utf8")));
        return {};
      },
      providerRequest: async (url, options) => {
        events.push("POST");expect(url).toBe("https://api.openai.com/v1/audio/speech");expect(JSON.parse(String(options.body))).toEqual({ model: "gpt-4o-mini-tts", voice: "marin", input: "A frozen script", response_format: "mp3" });
        expect(events.slice(-3)).toEqual(["speech_intent", "authority", "POST"]);
        return new Response("provider body is private", { status: 429 });
      } });
    expect(result).toEqual({ outcome: "rejected" });
    expect(events).toEqual(["download", "translation_result", "speech_intent", "authority", "POST", "final_result"]);
    expect(checkpoints.at(-1)).toMatchObject({ stage: "final_result", outcome: "rejected", providerStage: "speech", httpStatus: 429 });
    expect(JSON.stringify(checkpoints)).not.toContain("provider body");
  } finally { await rm(work, { recursive: true, force: true }); }
});

test("unconfirmed paid POST outcomes are sealed unknown once and intent acknowledgement loss prevents the POST", async () => {
  for (const mode of ["timeout", "server", "malformed", "lost_intent", "revoked"] as const) {
    const work = await mkdtemp(join(tmpdir(), "dub-unknown-")), command = await input();let posts = 0, final: unknown;
    try {
      const operation = () => executeDubbing(command, { work, signal: new AbortController().signal, apiKey: "test-key", sourceNames: ["base_video"], stages: ["translation_result", "speech_intent", "audio", "video", "final_result"],
        request: async value => {
          if (value.operation === "download") await writeFile(value.path, "abc");
          if (mode === "lost_intent" && value.operation === "checkpoint" && value.stage === "speech_intent") throw Error("lost_intent_ack");
          if (mode === "revoked" && value.operation === "authority") throw Error("authority_lost");
          if (value.operation === "checkpoint" && value.stage === "final_result") final = JSON.parse(await readFile(value.path, "utf8"));
          return {};
        }, providerRequest: async () => { posts++;if (mode === "timeout") throw Error("unconfirmed");return new Response(mode === "malformed" ? "not an mp3" : null, { status: mode === "server" ? 503 : 200 }); } });
      if (mode === "lost_intent" || mode === "revoked") { await expect(operation()).rejects.toThrow(mode === "lost_intent" ? "lost_intent_ack" : "authority_lost");expect(posts).toBe(0);expect(final).toBeUndefined(); }
      else { expect(await operation()).toEqual({ outcome: "unknown" });expect(posts).toBe(1);expect(final).toMatchObject({ outcome: "unknown", providerStage: "speech" }); }
    } finally { await rm(work, { recursive: true, force: true }); }
  }
});

test("real translated speech is probed and muxed once, and sealed recovery calls neither provider again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dub-real-")), base = join(directory, "fixture.mp4"), speech = join(directory, "fixture.mp3");
  const ffmpeg = promisify(execFile);
  await ffmpeg("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", base]);
  await ffmpeg("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-c:a", "libmp3lame", speech]);
  const command = await input((await stat(base)).size, "es"), stages = ["translation_intent", "translation_result", "speech_intent", "audio", "video", "final_result"] as const, evidence = new Map<string, unknown>(), files = new Map<string, string>();
  const events: string[] = [], posts: string[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;posts.push(path);
    const body = await request.json();
    if (path === "/v1/responses") { expect(body.model).toBe("gpt-5.4-mini");return Response.json({ id: "resp_controlled", output: [{ content: [{ text: "Un guion congelado" }] }] }); }
    expect(body.input).toBe("Un guion congelado");return new Response(await readFile(speech), { headers: { "Content-Type": "audio/mpeg" } });
  } });
  try {
    const first = await mkdtemp(join(directory, "first-"));
    const result = await executeDubbing(command, { work: first, signal: new AbortController().signal, apiKey: "test-key", sourceNames: ["base_video"], stages,
      request: async value => {
        events.push(value.operation === "checkpoint" || value.operation === "publish" ? value.stage : value.operation);
        if (value.operation === "download") await copyFile(base, value.path);
        if (value.operation === "checkpoint") { evidence.set(value.stage, JSON.parse(await readFile(value.path, "utf8")));files.set(value.stage, value.path); }
        if (value.operation === "publish") files.set(value.stage, value.path);
        return {};
      }, providerRequest: (url, options) => { expect(events.at(-1)).toBe("authority");return fetch(new URL(new URL(url).pathname, server.url), { method: "POST", headers: options.headers, body: String(options.body), signal: options.signal }); } });
    expect(result).toEqual({ outcome: "completed" });expect(posts).toEqual(["/v1/responses", "/v1/audio/speech"]);
    expect(events).toEqual(["download", "translation_intent", "authority", "translation_result", "speech_intent", "authority", "audio", "video", "final_result"]);
    const final = evidence.get("final_result") as { audio: object; video: object; probe: { state: string; durationSec: number } };
    for (const stage of ["audio", "video"] as const) { const bytes = await readFile(files.get(stage)!);expect(final[stage]).toEqual({ byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }); }
    expect(final.probe.state).toBe("ready");expect(final.probe.durationSec).toBeGreaterThan(1);
    const recovered = await mkdtemp(join(directory, "recovered-"));
    expect(await executeDubbing(command, { work: recovered, signal: new AbortController().signal, sourceNames: ["base_video", "translation_result", "dub_audio", "dub_video"], stages: ["final_result"],
      request: async value => { if (value.operation === "download") await copyFile(value.sourceName === "base_video" ? base : files.get(value.sourceName === "dub_audio" ? "audio" : value.sourceName === "dub_video" ? "video" : "translation_result")!, value.path);return {}; },
      providerRequest: async () => { throw Error("sealed recovery must not call a provider"); } })).toEqual({ outcome: "completed" });
    expect(posts).toHaveLength(2);
  } finally { server.stop(true);await rm(directory, { recursive: true, force: true }); }
}, 20_000);
