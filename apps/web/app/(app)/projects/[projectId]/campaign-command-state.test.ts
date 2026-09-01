import { describe, expect, test } from "bun:test";

import {
  buildApplyMotionSelectedInput,
  buildApplyProjectBrandProfileSelectedInput,
  buildApplySceneTemplateSelectedInput,
  buildApplyStyleSelectedInput,
  buildCampaignEditorRetryRequest,
  deriveCampaignCommandState,
  deriveCampaignMotionDialogState,
  serializeCampaignEditorActionPreflightRequest,
} from "./campaign-command-state";

function clip(id: string, ready: boolean, revision: number) {
  return {
    id,
    editorRevision: revision,
    brollUrl: null,
    brollPlacements: [],
    renderVariants: ready
      ? [
          {
            aspectRatio: "9:16" as const,
            status: "completed" as const,
            hasAsset: true,
            resolution: "1080p" as const,
          },
        ]
      : [],
  };
}

describe("campaign command state", () => {
  test("prepares only missing immutable exports for a mixed selection", () => {
    const state = deriveCampaignCommandState({
      clips: [clip("ready", true, 4), clip("missing", false, 7)],
      selectedIds: new Set(["ready", "missing"]),
      defaultAspectRatio: "9:16",
      actionAvailability: {
        exports: true,
        creative: true,
        motion: true,
      },
    });

    expect(state.primary).toBe("prepare_exports");
    expect(state.readyItems).toEqual([
      { clipId: "ready", expectedEditorRevision: 4 },
    ]);
    expect(state.attentionItems).toEqual([
      {
        clipId: "missing",
        expectedEditorRevision: 7,
        code: "export_required",
      },
    ]);
  });

  test("has no mutation for empty or unavailable selections", () => {
    const empty = deriveCampaignCommandState({
      clips: [clip("ready", true, 1)],
      selectedIds: new Set(),
      defaultAspectRatio: "9:16",
      actionAvailability: { exports: true, creative: true, motion: true },
    });
    expect(empty).toMatchObject({ selectedCount: 0, primary: null });

    const closed = deriveCampaignCommandState({
      clips: [clip("ready", true, 1)],
      selectedIds: new Set(["ready", "another-project"]),
      defaultAspectRatio: "9:16",
      actionAvailability: { exports: false, creative: false, motion: false },
    });
    expect(closed.primary).toBeNull();
    expect(closed.availableActions).toEqual([]);
    expect(closed.selectedClipIds).toEqual(["ready"]);
  });

  test("builds every creative action from the same revision fences", () => {
    const selectedItems = [
      { clipId: "a", expectedEditorRevision: 4, hasManualBroll: true },
      { clipId: "b", expectedEditorRevision: 7, hasManualBroll: false },
    ];
    const clips = [
      { clipId: "a", expectedEditorRevision: 4 },
      { clipId: "b", expectedEditorRevision: 7 },
    ];
    const templateId = "10000000-0000-4000-8000-000000000001";
    const fingerprint = "a".repeat(64);

    expect(
      buildApplyProjectBrandProfileSelectedInput(
        fingerprint,
        null,
        selectedItems,
      ),
    ).toEqual({ profileFingerprint: fingerprint, styleFingerprint: null, clips });
    expect(
      buildApplyStyleSelectedInput(templateId, fingerprint, selectedItems),
    ).toEqual({ templateId, templateFingerprint: fingerprint, clips });
    expect(
      buildApplySceneTemplateSelectedInput(fingerprint, "end", selectedItems),
    ).toEqual({ templateFingerprint: fingerprint, placement: "end", clips });
    expect(
      buildApplyMotionSelectedInput(
        {
          scope: "manual_broll",
          motion: { entrance: "ken-burns-in", exit: "fade" },
        },
        selectedItems,
      ),
    ).toEqual({
      change: {
        scope: "manual_broll",
        motion: { entrance: "ken-burns-in", exit: "fade" },
      },
      clips,
    });
  });

  test("previews exact mixed manual B-roll eligibility", () => {
    const withBroll = { ...clip("eligible", true, 3), brollUrl: "https://media.test/broll.mp4" };
    const state = deriveCampaignCommandState({
      clips: [withBroll, clip("missing", true, 5)],
      selectedIds: new Set(["eligible", "missing"]),
      defaultAspectRatio: "9:16",
      actionAvailability: { exports: true, creative: true, motion: true },
    });
    expect(deriveCampaignMotionDialogState(state, "manual_broll")).toEqual({
      eligibleCount: 1,
      attentionCount: 1,
      canSubmit: true,
    });
    expect(
      deriveCampaignMotionDialogState(
        deriveCampaignCommandState({
          clips: [clip("missing", true, 5)],
          selectedIds: new Set(["missing"]),
          defaultAspectRatio: "9:16",
          actionAvailability: { exports: true, creative: true, motion: true },
        }),
        "manual_broll",
      ),
    ).toMatchObject({ eligibleCount: 0, canSubmit: false });
  });

  test("retries only failed and refreshed stale items", () => {
    const fingerprint = "b".repeat(64);
    expect(
      buildCampaignEditorRetryRequest({
        operation: {
          action: "apply_style",
          items: [
            { requestedClipId: "success", status: "succeeded" },
            { requestedClipId: "same", status: "unchanged" },
            { requestedClipId: "blocked", status: "ineligible" },
            {
              requestedClipId: "stale",
              expectedEditorRevision: 5,
              status: "stale",
            },
            { requestedClipId: "failed", status: "failed" },
          ],
        },
        intent: {
          action: "apply_style",
          templateId: "10000000-0000-4000-8000-000000000001",
          templateFingerprint: fingerprint,
        },
        selectedItems: [
          { clipId: "success", expectedEditorRevision: 4, hasManualBroll: false },
          { clipId: "same", expectedEditorRevision: 4, hasManualBroll: false },
          { clipId: "blocked", expectedEditorRevision: 4, hasManualBroll: false },
          { clipId: "stale", expectedEditorRevision: 8, hasManualBroll: false },
          { clipId: "failed", expectedEditorRevision: 9, hasManualBroll: false },
        ],
      }),
    ).toEqual({
      action: "apply_style",
      input: {
        templateId: "10000000-0000-4000-8000-000000000001",
        templateFingerprint: fingerprint,
        clips: [
          { clipId: "stale", expectedEditorRevision: 8 },
          { clipId: "failed", expectedEditorRevision: 9 },
        ],
      },
    });
  });

  test("keeps equivalent preflight requests stable", () => {
    const request = {
      action: "apply_style",
      input: {
        templateId: "10000000-0000-4000-8000-000000000001",
        templateFingerprint: "c".repeat(64),
        clips: [{ clipId: "a", expectedEditorRevision: 2 }],
      },
    };
    expect(serializeCampaignEditorActionPreflightRequest(request)).toBe(
      serializeCampaignEditorActionPreflightRequest(structuredClone(request)),
    );
  });
});
