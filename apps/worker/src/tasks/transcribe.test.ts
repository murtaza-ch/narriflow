import { describe, expect, test } from "bun:test";
import { getAssemblyAiTranscript } from "./transcribe";

describe("AssemblyAI result polling failure disposition", () => {
  test("classifies an authentication response as permanent at the poll seam", async () => {
    await expect(
      getAssemblyAiTranscript("transcript-1", "bad-key", {
        maxRetries: 0,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
          }),
      }),
    ).rejects.toMatchObject({
      code: "assemblyai_transcription_poll_failed",
      disposition: "permanent",
    });
  });

  test("keeps a provider outage retryable at the poll seam", async () => {
    await expect(
      getAssemblyAiTranscript("transcript-1", "key", {
        maxRetries: 0,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "unavailable" }), {
            status: 503,
          }),
      }),
    ).rejects.toMatchObject({
      code: "assemblyai_transcription_poll_failed",
      disposition: "retryable",
    });
  });
});
