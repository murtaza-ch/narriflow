import { bindServiceTestEnvironment } from "@narriflow/services/runtime-test-support";
import { describe, expect, test } from "bun:test";
import { isStaleProgressReplay, narriflowProgressRequest, progressIsLive, progressOutcomeRequest, progressRefreshDelayMs } from "./mcp-apps/v2/progress";
import { clipView, confirmationView, progressView } from "./mcp-apps/v2/views";

describe("App operation progress", () => {
  test("refreshes accepted work through its exact Operation Status", bindServiceTestEnvironment(() => {
    expect(narriflowProgressRequest({ export: { exportId: "export" }, operation: { kind: "export", id: "export" } }, { workspaceId: "workspace", projectId: "project", clipId: "clip" }, {}))
      .toEqual({ name: "narriflow_get_operation", arguments: { workspaceId: "workspace", operation: { kind: "export", id: "export" } } });
    expect(narriflowProgressRequest({ operation: { kind: "generation", id: "run" }, projectId: "project" }, { workspaceId: "workspace" }, {}))
      .toEqual({ name: "narriflow_get_operation", arguments: { workspaceId: "workspace", operation: { kind: "generation", id: "run" } } });
  }));
  test("uses safe operation metadata when Tasks replaces the initial result", bindServiceTestEnvironment(() => {
    expect(narriflowProgressRequest({}, {}, { "narriflow/operation": { workspaceId: "workspace", projectId: "project", domainId: "job", domainKind: "intake" } }))
      .toEqual({ name: "narriflow_get_operation", arguments: { workspaceId: "workspace", operation: { kind: "intake", id: "job" } } });
    expect(() => narriflowProgressRequest({}, {}, { "narriflow/operation": { domainKind: "export", projectId: "project" } })).toThrow("Operation status is unavailable");
  }));
  test("a Project snapshot refreshes itself and never stands in for accepted work", bindServiceTestEnvironment(() => {
    expect(narriflowProgressRequest({ project: { workspaceId: "workspace", projectId: "project" } }, {}, {})).toEqual({ name: "narriflow_get_project", arguments: { workspaceId: "workspace", projectId: "project" } });
  }));
  test("renders Operation Status with partial outcomes", bindServiceTestEnvironment(() => {
    const view = progressView({ operation: { kind: "generation", id: "run" }, state: "partial", stage: "rendering", progress: 1,
      items: [{ kind: "clip", id: "a", state: "completed" }, { kind: "clip", id: "b", state: "failed" }] });
    expect(view.badge).toBe("Partial");
    expect(view.html).toContain("1 of 2 clips finished");
  }));
  test("a card keeps reading while work can change, and stops when it settles", () => {
    expect(progressIsLive({ export: { status: "queued" } })).toBe(true);
    expect(progressIsLive({ export: { status: "partial_ready" } })).toBe(true);
    expect(progressIsLive({ export: { status: "ready" } })).toBe(false);
    expect(progressIsLive({ export: { status: "failed" } })).toBe(false);
    expect(progressIsLive({ operation: { kind: "export", id: "e" }, state: "working" })).toBe(true);
    for (const state of ["completed", "partial", "failed", "cancelled"]) expect(progressIsLive({ operation: { kind: "export", id: "e" }, state })).toBe(false);
    expect(progressIsLive({ project: { projectId: "p" }, progress: { status: "processing" } })).toBe(true);
    expect(progressIsLive({ project: { projectId: "p" } })).toBe(false);
  });
  test("the original queued result cannot undo a finished card when the host replays it", () => {
    const finished = { operation: { kind: "export", id: "e" }, state: "completed", progress: 1 };
    const original = { export: { exportId: "e", status: "queued", progress: 0 }, operation: { kind: "export", id: "e" } };
    expect(isStaleProgressReplay(finished, original)).toBe(true);
    expect(isStaleProgressReplay({ export: { exportId: "e", status: "ready" } }, original)).toBe(true);
  });
  test("a newer state, and other work, are never treated as a replay", () => {
    const original = { export: { exportId: "e", status: "queued" }, operation: { kind: "export", id: "e" } };
    expect(isStaleProgressReplay(original, { operation: { kind: "export", id: "e" }, state: "completed" })).toBe(false);
    expect(isStaleProgressReplay({ operation: { kind: "export", id: "e" }, state: "working" }, original)).toBe(false);
    expect(isStaleProgressReplay({ operation: { kind: "export", id: "other" }, state: "completed" }, original)).toBe(false);
    expect(isStaleProgressReplay({}, original)).toBe(false);
  });
  test("a card reads at once, then quickly, then gently, and eventually stops", () => {
    expect(progressRefreshDelayMs(0)).toBe(0);
    expect(progressRefreshDelayMs(1)).toBe(3_000);
    expect(progressRefreshDelayMs(21)).toBe(15_000);
    expect(progressRefreshDelayMs(199)).toBe(15_000);
    expect(progressRefreshDelayMs(200)).toBeNull();
  });
  test("a finished export shows its files and a finished run shows its clips", () => {
    const meta = { "narriflow/operation": { workspaceId: "w" } };
    expect(progressOutcomeRequest({ operation: { kind: "export", id: "e" }, state: "completed", results: { exportId: "e" } }, {}, meta))
      .toEqual({ name: "narriflow_get_export_download", arguments: { workspaceId: "w", exportId: "e" } });
    expect(progressOutcomeRequest({ export: { exportId: "e", status: "ready" } }, { workspaceId: "w" }, {}))
      .toEqual({ name: "narriflow_get_export_download", arguments: { workspaceId: "w", exportId: "e" } });
    expect(progressOutcomeRequest({ operation: { kind: "generation", id: "r" }, state: "completed", results: { projectId: "p", exportId: null } }, {}, meta))
      .toEqual({ name: "narriflow_list_clips", arguments: { workspaceId: "w", projectId: "p", limit: 10 } });
  });
  test("work that failed or is still running offers no result to load", () => {
    expect(progressOutcomeRequest({ operation: { kind: "export", id: "e" }, state: "working", results: { exportId: "e" } }, {}, {})).toBeNull();
    expect(progressOutcomeRequest({ operation: { kind: "export", id: "e" }, state: "failed", results: { exportId: "e" } }, {}, {})).toBeNull();
    expect(progressOutcomeRequest({ export: { exportId: "e", status: "queued" } }, {}, {})).toBeNull();
  });
  test("generation steps follow the real stages, and a queued export says why it waits", () => {
    const working = progressView({ operation: { kind: "generation", id: "r" }, state: "working", stage: "detecting", progress: 0.4, items: [] });
    expect(working.tone).toBe("live");
    expect(working.html).toContain("Find moments");
    expect(working.html.indexOf('data-state="current"')).toBeGreaterThan(working.html.indexOf("Transcribe"));
    expect(progressView({ operation: { kind: "export", id: "e" }, state: "working", stage: "rendering", progress: 0, items: [] }).html).toContain("render slot");
  });
  test("a finished export renders its files without exposing signed links", () => {
    const view = progressView({ operation: { kind: "export", id: "e" }, state: "completed", stage: "rendering", progress: 1, items: [] },
      { variants: [{ aspectRatio: "1:1", resolution: "720p", sizeBytes: 5_991_195, watermark: false, downloadUrl: "https://private.example/signed" }] });
    expect(view.title).toBe("Your export is ready");
    expect(view.html).toContain("6.0 MB");
    expect(view.html).toContain('id="result-video"');
    expect(view.html).not.toContain("private.example");
  });
  test("clip titles from the result list are escaped", () => {
    const view = progressView({ operation: { kind: "generation", id: "r" }, state: "completed", stage: "rendering", progress: 1, items: [] },
      { items: [{ title: "<img src=x>", durationSec: 61, category: "tutorial", scores: { virality: 77 } }] });
    expect(view.html).toContain("&lt;img src=x&gt;");
    expect(view.html).not.toContain("<img");
    expect(view.html).toContain("1:01");
  });
  test("failed work never claims to still be preparing", () => {
    const stopped = { operation: { kind: "export", id: "e" }, state: "failed", stage: "rendering", progress: 0.6, items: [] };
    expect(progressView(stopped).title).toBe("This export needs attention");
    expect(progressView({ export: { exportId: "e", status: "failed", variants: [] } }).title).toBe("This export needs attention");
    expect(progressView({ ...stopped, operation: { kind: "generation", id: "r" } }).title).toBe("These clips need attention");
    expect(progressView({ ...stopped, state: "cancelled" }).title).toBe("This work was cancelled");
  });
  test("one file is downloaded from the main button, several from their rows", () => {
    const done = { operation: { kind: "export", id: "e" }, state: "completed", stage: "rendering", progress: 1, items: [] };
    const file = { aspectRatio: "1:1", resolution: "720p", sizeBytes: 1_000_000, watermark: false };
    expect(progressView(done, { variants: [file] }).html).not.toContain("data-download");
    expect(progressView(done, { variants: [file, { ...file, aspectRatio: "9:16" }] }).html).toContain('data-download="1"');
  });
  test("clip review shows a verdict, real platform marks and the chosen format", () => {
    const card = clipView({ clip: { title: "T", startSec: 0, endSec: 60, durationSec: 60, platformFit: ["tiktok", "youtube_shorts", "instagram_reels"], scores: { virality: 77, hookStrength: 84, emotionalIntensity: 39 } } }, { aspectRatio: "16:9", resolution: "720p" });
    expect(card.html).toContain("Strong");
    expect(card.html.match(/class="logo"/g)).toHaveLength(3);
    expect(card.html).toContain('data-value="16:9" aria-pressed="true"');
    expect(card.html).toContain('data-value="720p" aria-pressed="true"');
    expect(card.html).toContain("data-dock");
    expect(card.html).toContain('data-strength="low"');
  });
  test("every fact of a post approval stays on the card, outside any disclosure", () => {
    const card = confirmationView({ accountDisplayName: "Demo", intent: { caption: "Hello", platform: "tiktok", aspectRatio: "9:16", resolution: "1080p", expectedEditorRevision: 4, scheduledFor: "2026-11-09T14:00:00Z", deliveryMode: "inbox", providerSettings: { disableComments: true } } }, "en-US");
    const visible = card.html.slice(0, card.html.indexOf("<details"));
    for (const fact of ["Demo", "TikTok", "Hello", "Publish at", "Nov 9, 2026", "9:16 / 1080p / Version 4", "Send to inbox"]) expect(visible).toContain(fact);
    expect(card.html.match(/Hello/g)).toHaveLength(1);
  });
});
