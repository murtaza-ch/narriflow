import { describe, expect, test } from "bun:test";
import { clipView, uploadView, progressView, confirmationView } from "./mcp-apps/v2/views";

describe("Assistant card product projections", () => {
  test("clip review escapes user text and excludes identifiers, URLs and unrelated response fields", () => {
    const card = clipView({ clip: { title: '<img src=x onerror="alert(1)">', hookText: "A < B & C", clipId: "private-clip-id", projectId: "private-project-id", reviewUrl: "https://narriflow.test/private-link", storageKey: "private-storage", hasPreview: true, editorRevision: 3, startSec: 47.385, endSec: 66.428, durationSec: 19, scores: { virality: 80, hookStrength: 96, pacing: 90, storyCompleteness: 80, emotionalIntensity: 58, durationOptimality: 71 } } });
    expect(card.title).toBe('<img src=x onerror="alert(1)">'); // Assigned through textContent by the bridge.
    expect(card.html).toContain("A &lt; B &amp; C");
    expect(card.html).not.toContain("private-");
    expect(card.html).not.toContain("onerror");
    expect(card.html).toContain("0:47–1:06");
    expect(card.html).toContain('value="96"');
  });
  test("upload displays choices without exposing signed continuations or replay identity", () => {
    const card = uploadView({ workspaceId: "private-workspace", handoffUrl: "https://narriflow.test/?intent=private-token", localUploadCommand: "private-command" }, { clientIdempotencyKey: "private-key", generationContext: { contentPack: { defaultAspectRatio: "9:16", clipLengthPreset: "under_30s", captionPreset: "minimal" } } });
    expect(card.html).not.toContain("private-");
    expect(card.html).toContain("Under 30 seconds");
    expect(card.html).toContain("Minimal captions");
    expect(card.html).toContain('type="file"');
    const received = uploadView({ outcome: "queued_for_ingest" }, {});
    expect(received.badge).toBe("Upload received");
    expect(received.html).not.toContain('type="file"');
  });
  test("confirmation shows the selected destination, exact format/version, caption and settings without tokens", () => {
    const card = confirmationView({ accountDisplayName: "Narriflow demo", preparationToken: "private-token", intent: { caption: "<script>bad()</script>", platform: "tiktok", aspectRatio: "9:16", resolution: "1080p", expectedEditorRevision: 4, scheduledFor: "2026-10-06T14:00:00Z", deliveryMode: "direct", accountId: "private-account", clipExportId: "private-export", providerSettings: { disableComments: true } } }, "en-US");
    expect(card.html).toContain("Narriflow demo");
    expect(card.html).toContain("9:16 / 1080p / Version 4");
    expect(card.html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(card.html).toContain("Disable Comments");
    expect(card.html).not.toContain("private-");
  });
  test("export progress reflects the export and warns about an earlier edit", () => {
    const card = progressView({ project: { title: "Unrelated project" }, export: { status: "ready", progress: 100, resolution: "1080p", editorRevision: 0, isOlderVersion: true, variants: [{ aspectRatio: "9:16" }] } });
    expect(card.title).toBe("Your export is ready");
    expect(card.html).toContain("earlier edit");
    expect(card.html).not.toContain("Unrelated project");
  });
  test("an incomplete confirmation result never claims approval or scheduling", () => {
    const card = confirmationView({ status: "confirmation_required" });
    expect(card.badge).toBe("Review required");
    expect(card.html).not.toContain("Post scheduled");
  });
});
