import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { ProviderSettlementResult } from "@narriflow/services";
import { Hono } from "hono";
import { createProjectsWebhookRoutes, type ProjectsWebhookDeps } from "./webhooks";

const SECRET = "wsec_test_secret";
const NOW_S = 1_800_000_000;
const encoder = new TextEncoder();
const metadata = { workflowRunId: "run-1", attemptId: "attempt-1" };

function signedHeader(body: string, t = NOW_S, secret = SECRET): string {
  return `t=${t},v0=${createHmac("sha256", secret).update(`${t}.`).update(encoder.encode(body)).digest("hex")}`;
}

function harness(overrides: Partial<ProjectsWebhookDeps> = {}) {
  const finalized: Parameters<ProjectsWebhookDeps["finalizeScribeTranscript"]>[0][] = [];
  const failed: { key: unknown; failure: unknown; ids: unknown }[] = [];
  const deps: ProjectsWebhookDeps = {
    webhookSecret: () => SECRET,
    now: () => NOW_S * 1000,
    finalizeScribeTranscript: async (input) => {
      finalized.push(input);
      return { kind: "applied" };
    },
    failProviderAttempt: async (key, failure, ids) => {
      failed.push({ key, failure, ids });
      return { kind: "applied" };
    },
    ...overrides,
  };
  const app = new Hono().route("/api", createProjectsWebhookRoutes(deps));
  const post = (body: string, header: string | null = signedHeader(body)) =>
    app.request("/api/webhooks/elevenlabs", {
      method: "POST",
      headers: header === null ? {} : { "elevenlabs-signature": header },
      body,
    });
  return { post, finalized, failed };
}

const success = (extra: Record<string, unknown> = {}, webhookMetadata: unknown = JSON.stringify(metadata)) =>
  JSON.stringify({
    type: "speech_to_text_transcription",
    event_timestamp: NOW_S,
    data: {
      request_id: "req-1",
      webhook_metadata: webhookMetadata,
      transcription: { transcription_id: "tr-1", language_code: "eng", text: "héllo 世界", words: [], ...extra },
    },
  });

describe("ElevenLabs webhook signature gate", () => {
  test("rejects every bad signature with 401 and never settles", async () => {
    const t = harness();
    const body = success();
    const cases: (string | null)[] = [
      null,
      "garbage",
      `t=${NOW_S},v0=${"0".repeat(64)}`,
      signedHeader(body, NOW_S - 31 * 60),
      signedHeader(body, NOW_S + 6 * 60),
      signedHeader(body, NOW_S, "other-secret"),
      signedHeader(`${body} `),
    ];
    for (const header of cases) {
      const response = await t.post(body, header);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "invalid_signature" });
    }
    expect(t.finalized).toEqual([]);
    expect(t.failed).toEqual([]);
  });

  test("an unconfigured secret answers 503 so ElevenLabs retries", async () => {
    const t = harness({ webhookSecret: () => null });
    expect((await t.post(success())).status).toBe(503);
    expect(t.finalized).toEqual([]);
  });

  test("a Unicode body verifies and reaches the finalizer unchanged", async () => {
    const t = harness();
    expect((await t.post(success())).status).toBe(200);
    expect((t.finalized[0]?.payload as { text: string }).text).toBe("héllo 世界");
  });
});

describe("ElevenLabs success envelope", () => {
  test("finalizes the transcription with the attempt key and provider ids", async () => {
    const t = harness();
    const response = await t.post(success());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, disposition: "applied" });
    expect(t.finalized).toEqual([
      {
        key: metadata,
        payload: expect.objectContaining({ transcription_id: "tr-1", text: "héllo 世界" }),
        providerIds: { requestId: "req-1", transcriptionId: "tr-1" },
      },
    ]);
  });

  test("webhook_metadata may be an object, and a missing transcription_id becomes null", async () => {
    const t = harness();
    const body = JSON.stringify({
      type: "speech_to_text_transcription",
      data: { request_id: "req-2", webhook_metadata: metadata, transcription: { text: "x", words: [] } },
    });
    expect((await t.post(body)).status).toBe(200);
    expect(t.finalized[0]?.key).toEqual(metadata);
    expect(t.finalized[0]?.providerIds).toEqual({ requestId: "req-2", transcriptionId: null });
  });

  test("duplicate, stale and terminal settlements are acknowledged with 200", async () => {
    const results: ProviderSettlementResult[] = [
      { kind: "applied" },
      { kind: "duplicate" },
      { kind: "stale", reason: "attempt_superseded" },
      { kind: "terminal", status: "completed" },
    ];
    const t = harness({ finalizeScribeTranscript: async () => results.shift() as ProviderSettlementResult });
    const body = success();
    const dispositions: unknown[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await t.post(body);
      expect(response.status).toBe(200);
      dispositions.push(((await response.json()) as { disposition: string }).disposition);
    }
    expect(dispositions).toEqual(["applied", "duplicate", "stale", "terminal"]);
  });

  test("missing, malformed or incomplete metadata is a 200 no-op with a structured log", async () => {
    const t = harness();
    const logs: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => void logs.push(line);
    try {
      for (const bad of [null, "not json", "[]", JSON.stringify({ workflowRunId: "run-1" }), { attemptId: "a" }, { workflowRunId: 1, attemptId: "a" }]) {
        const response = await t.post(success({}, bad));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ received: true, disposition: "ignored" });
      }
    } finally {
      console.warn = warn;
    }
    expect(t.finalized).toEqual([]);
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ level: "warn", message: "elevenlabs_webhook_ignored", reason: "missing_or_invalid_metadata" }),
    );
  });

  test("a missing transcription is a 200 no-op", async () => {
    const t = harness();
    const body = JSON.stringify({ type: "speech_to_text_transcription", data: { request_id: "r", webhook_metadata: metadata } });
    expect((await t.post(body)).status).toBe(200);
    expect(t.finalized).toEqual([]);
  });

  test("a temporary persistence failure is a generic 500 so ElevenLabs retries", async () => {
    const t = harness({
      finalizeScribeTranscript: async () => {
        throw new Error("connect ECONNRESET postgres://secret@host");
      },
    });
    const response = await t.post(success());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "elevenlabs_webhook_failed" });
  });
});

describe("ElevenLabs error envelope", () => {
  const errorBody = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "webhook_error",
      request_id: "req-9",
      error_message: "audio could not be decoded for user@example.com",
      webhook_metadata: JSON.stringify(metadata),
      ...extra,
    });

  test("fails the matching attempt with a retryable generic failure", async () => {
    const t = harness();
    const response = await t.post(errorBody());
    expect(response.status).toBe(200);
    expect(t.failed).toEqual([
      {
        key: metadata,
        failure: {
          code: "elevenlabs_transcription_failed",
          retryable: true,
          message: "ElevenLabs could not complete the transcription.",
        },
        ids: { requestId: "req-9" },
      },
    ]);
    expect(JSON.stringify(t.failed)).not.toContain("user@example.com");
  });

  test("missing metadata is a 200 no-op; a persistence failure is a 500", async () => {
    const t = harness();
    expect((await t.post(errorBody({ webhook_metadata: undefined }))).status).toBe(200);
    expect(t.failed).toEqual([]);
    const failing = harness({
      failProviderAttempt: async () => {
        throw new Error("db down");
      },
    });
    expect((await failing.post(errorBody())).status).toBe(500);
  });

  test("a stale or terminal failure is acknowledged", async () => {
    const t = harness({ failProviderAttempt: async () => ({ kind: "terminal", status: "failed" }) });
    const response = await t.post(errorBody());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, disposition: "terminal" });
  });
});

describe("ElevenLabs unknown deliveries", () => {
  test("an unknown type, a non-object body and invalid JSON are 200 no-ops once signed", async () => {
    const t = harness();
    for (const body of [JSON.stringify({ type: "something_else" }), "[]", "not json", JSON.stringify({})]) {
      const response = await t.post(body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true, disposition: "ignored" });
    }
    expect(t.finalized).toEqual([]);
    expect(t.failed).toEqual([]);
  });
});
