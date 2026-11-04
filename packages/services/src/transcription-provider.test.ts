import { expect, test } from "bun:test";
import { createScribeProvider, ScribeSubmissionUnconfirmed } from "./transcription-provider";

const reference = { workflowRunId: "ce4d7e7e-caae-4d85-80f8-17f55e2eaf79", attemptId: "05bfd4bb-8ce2-455c-a598-1328f676a288",
  deploymentEpoch: 3, sourceRevision: 2, sourceAudioId: "d5ab39a2-80e7-45d1-8da8-5bc90097075e" };

test("Scribe receives only the immutable audio URL and exact callback lineage in one multipart POST", async () => {
  let calls = 0;
  const provider = createScribeProvider({ apiKey: "test-secret", webhookId: "webhook", fetch: async (url, init) => {
    calls++;
    expect(String(url)).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(new Headers(init?.headers).get("xi-api-key")).toBe("test-secret");
    const form = init?.body as FormData;
    expect(form.get("cloud_storage_url")).toBe("https://audio.example/source.m4a?grant=1");
    expect(form.has("source_url")).toBe(false);
    expect(form.has("file")).toBe(false);
    expect(form.get("language_code")).toBe("urd");
    expect(JSON.parse(String(form.get("webhook_metadata")))).toEqual(reference);
    expect(form.get("diarize")).toBe("true");
    return Response.json({ request_id: "req", transcription_id: "transcript" }, { status: 202 });
  } });
  expect(await provider.submit({ reference, sourceAudioUrl: "https://audio.example/source.m4a?grant=1", languageCode: "urd" })).toEqual({ requestId: "req", transcriptionId: "transcript" });
  expect(calls).toBe(1);
});

test("unknown POST acceptance is never retried by the provider client", async () => {
  for (const response of [() => { throw new TypeError("socket reset"); }, () => Response.json({ request_id: "req" }, { status: 202 }),
    () => new Response("unreadable", { status: 200 })]) {
    let calls = 0;
    const provider = createScribeProvider({ apiKey: "secret", webhookId: "webhook", fetch: async () => { calls++; return response(); } });
    await expect(provider.submit({ reference, sourceAudioUrl: "https://audio.example/source.m4a", languageCode: null })).rejects.toBeInstanceOf(ScribeSubmissionUnconfirmed);
    expect(calls).toBe(1);
  }
});

test("GET recovery distinguishes pending, transient failure and completed payload", async () => {
  const pending = createScribeProvider({ apiKey: "secret", webhookId: "webhook", fetch: async () => Response.json({ detail: { code: "transcript_not_found" } }, { status: 404 }) });
  expect(await pending.result("id")).toEqual({ kind: "pending" });
  const transient = createScribeProvider({ apiKey: "secret", webhookId: "webhook", fetch: async () => Response.json({}, { status: 503 }) });
  expect((await transient.result("id")).kind).toBe("transient");
  const ready = createScribeProvider({ apiKey: "secret", webhookId: "webhook", fetch: async url => {
    expect(String(url)).toEndWith("/a%2Fb%3Fc");
    return Response.json({ text: "hello", words: [] });
  } });
  expect(await ready.result("a/b?c")).toEqual({ kind: "ready", payload: { text: "hello", words: [] } });
});

test("the optional language probe posts only bounded native WAV bytes and pins with the existing confidence policy", async () => {
  let requests = 0;
  const wav = new Uint8Array(48); wav.set(new TextEncoder().encode("RIFF")); wav.set(new TextEncoder().encode("WAVE"), 8);
  const provider = createScribeProvider({ apiKey: "secret", webhookId: "webhook", fetch: async (_url, init) => {
    requests++;
    const form = init!.body as FormData;
    expect(form.has("cloud_storage_url")).toBe(false);
    expect(form.has("source_url")).toBe(false);
    expect(form.has("webhook")).toBe(false);
    expect(form.has("diarize")).toBe(false);
    const file = form.get("file") as Blob;
    expect(file.size).toBe(48);
    expect(file.type).toBe("audio/wav");
    return Response.json({ language_code: "urd", language_probability: 0.94, words: Array.from({ length: 16 }, () => ({ type: "word" })) });
  } });
  expect(await provider.probe({ wav })).toEqual({ pinned: "ur", detected: "urd", probability: 0.94, wordCount: 16, reason: "pinned" });
  expect(requests).toBe(1);
  expect(await provider.probe({ wav: new Uint8Array(2_000_001) })).toMatchObject({ pinned: null, reason: "probe_invalid" });
  expect(requests).toBe(1);
});

test("provider probe throttling keeps Auto without retrying or failing the full transcription", async () => {
  let requests = 0;
  const wav = new Uint8Array(48); wav.set(new TextEncoder().encode("RIFF")); wav.set(new TextEncoder().encode("WAVE"), 8);
  const provider = createScribeProvider({ apiKey: "secret", webhookId: "webhook", fetch: async () => { requests++; return Response.json({}, { status: 429 }); } });
  expect(await provider.probe({ wav })).toMatchObject({ pinned: null, reason: "provider_http_429" });
  expect(requests).toBe(1);
});

test("a 429 from Scribe carries its Retry-After so the next attempt waits that long", async () => {
  const limited = () => new Response("{}", { status: 429, headers: { "retry-after": "90" } });
  const submitting = createScribeProvider({ apiKey: "secret", webhookId: "webhook", fetch: async () => limited() });
  await expect(submitting.submit({ reference, sourceAudioUrl: "https://audio.example/source.m4a?grant=1", languageCode: null }))
    .rejects.toMatchObject({ code: "elevenlabs_transcription_submit_failed", disposition: "retryable", retryAfterMs: 90_000 });
  const reading = createScribeProvider({ apiKey: "secret", webhookId: "webhook", fetch: async () => limited() });
  expect(await reading.result("transcript")).toMatchObject({ kind: "transient", failure: { retryAfterMs: 90_000 } });
  const silent = createScribeProvider({ apiKey: "secret", webhookId: "webhook", fetch: async () => new Response("{}", { status: 429 }) });
  expect(await silent.result("transcript")).toMatchObject({ kind: "transient", failure: { retryAfterMs: null } });
});
