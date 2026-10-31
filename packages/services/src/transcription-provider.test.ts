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
