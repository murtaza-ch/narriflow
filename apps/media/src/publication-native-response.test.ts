import { expect, test } from "bun:test";
import { createPublicationProviderTransport } from "./publication-provider-transport";
import { createPublicationWebhookPlatform } from "./publication-webhook";

test("native publication reads bounded real-network responses on the pinned Bun runtime", async () => {
  const body = JSON.stringify({ status: "accepted", receipt: { id: "loopback-receipt" }, padding: "x".repeat(12 * 1024) });
  const receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/oversize" ? new Response(new ReadableStream<Uint8Array>({ async start(controller) { controller.enqueue(new Uint8Array(32768)); await new Promise(resolve => setTimeout(resolve, 5)); controller.enqueue(new Uint8Array(32769)); controller.close(); } })) : new Response(body, { headers: { "Content-Type": "application/json" } }) });
  try {
    const transport = createPublicationProviderTransport({ platform: "x", command: async () => ({ kind: "recorded" }), fetch: (() => fetch(receiver.url)) as typeof fetch });
    const response = await transport.fetch("https://api.x.com/2/users/me");
    expect(await response.text()).toBe(body);
    let oversized = false;
    const platform = createPublicationWebhookPlatform({ clock: { now: () => new Date() }, sign: () => "sha256=synthetic", config: { url: "https://receiver.example.test/publication", deadlineMs: 10_000, maxResponseBytes: 65536, redirectPolicy: "error", reconciliationMaxMs: 3600_000 },
      transport: { send: async (_request, context) => { await context.onRequestCommitted(); return fetch(new URL(oversized ? "/oversize" : "/", receiver.url)); } },
      media: { createScopedAccess: async () => ({ url: "https://media.example.test/assigned", expiresAt: new Date(Date.now() + 60_000) }) },
    });
    const publish = () => platform.publish({ attemptId: "attempt-one", idempotencyKey: "attempt-one", socialPostId: "post-one", projectId: "project-one", platform: "youtube_shorts", caption: "Synthetic", scheduledFor: new Date(), providerSettings: {}, account: null,
      media: { storageKey: "private/assigned.mp4", fileName: "assigned.mp4", contentType: "video/mp4", sizeBytes: 1024, aspectRatio: "9:16" } },
      { signal: AbortSignal.timeout(10_000), checkpoint: async () => undefined });
    expect(await publish()).toMatchObject({ kind: "accepted", receipt: { receiptId: "loopback-receipt" } });
    oversized = true;
    expect(await publish()).toMatchObject({ kind: "unknown", code: "publication_webhook_response_oversized" });
  } finally { await receiver.stop(true); }
});
