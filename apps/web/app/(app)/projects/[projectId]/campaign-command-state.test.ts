import { describe, expect, test } from "bun:test";

import {
  buildApplyProjectBrandProfileSelectedInput,
  buildApplySceneTemplateSelectedInput,
  buildApplyStyleSelectedInput,
  buildApplyMotionSelectedInput,
  buildCampaignEditorRetryRequest,
  canSubmitCampaignMotion,
  campaignMotionMissingTargets,
  deriveCampaignMotionDialogState,
  deriveCampaignCommandState,
  serializeCampaignEditorActionPreflightRequest,
} from "./campaign-command-state";

function clip(id: string, ready: boolean, revision = 1, brollUrl: string | null = null) {
  return {
    id,
    editorRevision: revision,
    brollUrl,
		durationSec: 20,
		editedDurationSec: 20,
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
  test("keeps equivalent editor-action preflight requests stable across host rerenders", () => {
    const first = {
      action: "apply_brand_profile",
      input: {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        profileFingerprint: "a".repeat(64),
        styleFingerprint: null,
        items: [{ clipId: "00000000-0000-4000-8000-000000000002", expectedEditorRevision: 4 }],
      },
    };
    const equivalent = structuredClone(first);

    expect(serializeCampaignEditorActionPreflightRequest(first)).toBe(
      serializeCampaignEditorActionPreflightRequest(equivalent),
    );
    equivalent.input.items[0]!.expectedEditorRevision = 5;
    expect(serializeCampaignEditorActionPreflightRequest(first)).not.toBe(
      serializeCampaignEditorActionPreflightRequest(equivalent),
    );
  });

  test("fails closed when only legacy render adoption is staged", () => {
    const state = deriveCampaignCommandState({
      clips: [clip("a", true)],
      selectedIds: new Set(["a"]),
      defaultAspectRatio: "9:16",
      approvalRequired: false,
      actionAvailability: {
        exports: false,
        creative: false,
        motion: false,
        review: false,
        scheduling: false,
      },
    });

    expect(state.primary).toBeNull();
    expect(state.availableActions).toEqual([]);
  });

  test("exposes only the campaign actions whose ordered stages are open", () => {
    const input = {
      clips: [clip("a", true)],
      selectedIds: new Set(["a"]),
      defaultAspectRatio: "9:16" as const,
      approvalRequired: true,
      actionAvailability: {
        exports: true,
        creative: true,
        motion: false,
        review: false,
        scheduling: false,
      },
    };

    expect(deriveCampaignCommandState(input).availableActions).toEqual([
      "export_bundle",
      "apply_brand_profile",
      "apply_style",
      "apply_scene_template",
    ]);
    expect(
      deriveCampaignCommandState({
        ...input,
        actionAvailability: {
          ...input.actionAvailability,
          motion: true,
          review: true,
          scheduling: true,
        },
      }).availableActions,
    ).toEqual([
      "export_bundle",
      "apply_brand_profile",
      "apply_style",
      "apply_scene_template",
      "apply_motion",
      "create_review",
      "schedule_posts",
    ]);
  });

  test("has no primary mutation for an empty selection", () => {
    expect(
      deriveCampaignCommandState({
        clips: [clip("a", false)],
        selectedIds: new Set(),
        defaultAspectRatio: "9:16",
        actionAvailability: {
          exports: true,
          creative: true,
          motion: true,
          review: true,
          scheduling: true,
        },
        approvalRequired: true,
      }),
    ).toMatchObject({ selectedCount: 0, primary: null });
  });

  test("prepares only missing immutable exports for a mixed selection", () => {
    const state = deriveCampaignCommandState({
      clips: [
        clip("a", true, 4, "https://media.example.test/a.mp4"),
        clip("b", false, 7),
      ],
      selectedIds: new Set(["a", "b"]),
      defaultAspectRatio: "9:16",
      actionAvailability: {
        exports: true,
        creative: true,
        motion: true,
        review: true,
        scheduling: true,
      },
      approvalRequired: true,
    });

    expect(state.primary).toBe("prepare_exports");
    expect(state.readyItems).toEqual([{ clipId: "a", expectedEditorRevision: 4 }]);
    expect(state.attentionItems).toEqual([
      { clipId: "b", expectedEditorRevision: 7, code: "export_required" },
    ]);
    expect(state.selectedItems).toEqual([
      { clipId: "a", expectedEditorRevision: 4, hasManualBroll: true },
      { clipId: "b", expectedEditorRevision: 7, hasManualBroll: false },
    ]);
  });

  test("hands fully prepared selections to review before scheduling", () => {
    expect(
      deriveCampaignCommandState({
        clips: [clip("a", true), clip("b", true)],
        selectedIds: new Set(["a", "b"]),
        defaultAspectRatio: "9:16",
        actionAvailability: {
          exports: true,
          creative: true,
          motion: true,
          review: true,
          scheduling: true,
        },
        approvalRequired: true,
      }).primary,
    ).toBe("create_review");
  });

  test("hands approved-policy selections to scheduling and otherwise to ZIP", () => {
    const common = {
      clips: [clip("a", true)],
      selectedIds: new Set(["a"]),
      defaultAspectRatio: "9:16" as const,
      approvalRequired: false,
      actionAvailability: {
        exports: true,
        creative: true,
        motion: true,
        review: true,
        scheduling: true,
      },
    };
    expect(
      deriveCampaignCommandState(common).primary,
    ).toBe("schedule_posts");
    expect(
      deriveCampaignCommandState({
        ...common,
        actionAvailability: { ...common.actionAvailability, scheduling: false },
      }).primary,
    ).toBe("export_bundle");
  });

  test("ignores stale stored ids that are not in the current project clip list", () => {
    const state = deriveCampaignCommandState({
      clips: [clip("a", true)],
      selectedIds: new Set(["a", "other-project"]),
      defaultAspectRatio: "9:16",
      actionAvailability: {
        exports: false,
        creative: false,
        motion: false,
        review: false,
        scheduling: false,
      },
      approvalRequired: false,
    });
    expect(state.selectedCount).toBe(1);
    expect(state.selectedClipIds).toEqual(["a"]);
    expect(state.selectedItems).toEqual([
      { clipId: "a", expectedEditorRevision: 1, hasManualBroll: false },
    ]);
  });

  test("previews exact manual B-roll eligibility and submits only revision-fenced fields", () => {
    const state = deriveCampaignCommandState({
      clips: [
        clip("a", true, 4, "https://media.example.test/a.mp4"),
        clip("b", true, 7),
      ],
      selectedIds: new Set(["a", "b"]),
      defaultAspectRatio: "9:16",
      actionAvailability: {
        exports: false,
        creative: false,
        motion: false,
        review: false,
        scheduling: false,
      },
      approvalRequired: false,
    });

    expect(campaignMotionMissingTargets(state, "clip_transition")).toEqual([]);
    expect(campaignMotionMissingTargets(state, "manual_broll")).toEqual([
      { clipId: "b", expectedEditorRevision: 7, hasManualBroll: false },
    ]);
    expect(canSubmitCampaignMotion(state, "manual_broll")).toBe(true);
    expect(
      buildApplyMotionSelectedInput(
        {
          scope: "manual_broll",
          motion: { entrance: "fade", exit: "ken-burns-out" },
        },
        state.selectedItems,
      ),
    ).toEqual({
      change: {
        scope: "manual_broll",
        motion: { entrance: "fade", exit: "ken-burns-out" },
      },
      clips: [
        { clipId: "a", expectedEditorRevision: 4 },
        { clipId: "b", expectedEditorRevision: 7 },
      ],
    });
  });

	test("uses the post-delete duration when previewing URL-backed motion eligibility", () => {
		const urlClip = {
			...clip("short-after-cuts", true, 4, "https://media.example.test/a.mp4"),
			editedDurationSec: 11.9,
		};
		const state = deriveCampaignCommandState({
			clips: [urlClip],
			selectedIds: new Set([urlClip.id]),
			defaultAspectRatio: "9:16",
			actionAvailability: {
				exports: true,
				creative: true,
				motion: true,
				review: false,
				scheduling: false,
			},
			approvalRequired: false,
		});

		expect(state.selectedItems).toEqual([{
			clipId: urlClip.id,
			expectedEditorRevision: 4,
			hasManualBroll: false,
		}]);
		expect(canSubmitCampaignMotion(state, "manual_broll")).toBe(false);
	});

  test("treats an asset-backed bounded placement as manual B-roll", () => {
    const placed = {
      ...clip("asset", true, 3),
      brollPlacements: [
        {
          id: "10000000-0000-4000-8000-000000000010",
          asset: {
            kind: "visual_asset" as const,
            id: "10000000-0000-4000-8000-000000000011",
            fingerprint: "a".repeat(64),
          },
          provenance: "generated" as const,
          mediaKind: "image" as const,
          startSec: 1,
          endSec: 4,
          sourceStartSec: null,
          sourceEndSec: null,
        },
      ],
    };
    const state = deriveCampaignCommandState({
      clips: [placed],
      selectedIds: new Set([placed.id]),
      defaultAspectRatio: "9:16",
      actionAvailability: {
        exports: true,
        creative: true,
        motion: true,
        review: false,
        scheduling: false,
      },
      approvalRequired: false,
    });

    expect(state.selectedItems).toEqual([
      { clipId: "asset", expectedEditorRevision: 3, hasManualBroll: true },
    ]);
    expect(campaignMotionMissingTargets(state, "manual_broll")).toEqual([]);
  });

  test("blocks a knowingly empty manual B-roll operation", () => {
    const state = deriveCampaignCommandState({
      clips: [clip("missing", true, 2)],
      selectedIds: new Set(["missing"]),
      defaultAspectRatio: "9:16",
      actionAvailability: {
        exports: true,
        creative: true,
        motion: true,
        review: false,
        scheduling: false,
      },
      approvalRequired: false,
    });

    expect(canSubmitCampaignMotion(state, "manual_broll")).toBe(false);
    expect(canSubmitCampaignMotion(state, "clip_transition")).toBe(true);
  });

  test("blocks the motion dialog when every selected clip lacks manual B-roll", () => {
    const state = deriveCampaignCommandState({
      clips: [clip("missing-a", true, 2), clip("missing-b", true, 4)],
      selectedIds: new Set(["missing-a", "missing-b"]),
      defaultAspectRatio: "9:16",
      actionAvailability: {
        exports: true,
        creative: true,
        motion: true,
        review: false,
        scheduling: false,
      },
      approvalRequired: false,
    });

    expect(deriveCampaignMotionDialogState(state, "manual_broll")).toEqual({
      eligibleCount: 0,
      attentionCount: 2,
      canSubmit: false,
    });
  });

  test("keeps the motion dialog enabled for a mixed manual B-roll selection", () => {
    const state = deriveCampaignCommandState({
      clips: [
        clip("eligible", true, 3, "https://media.example.test/broll.mp4"),
        clip("missing", true, 5),
      ],
      selectedIds: new Set(["eligible", "missing"]),
      defaultAspectRatio: "9:16",
      actionAvailability: {
        exports: true,
        creative: true,
        motion: true,
        review: false,
        scheduling: false,
      },
      approvalRequired: false,
    });

    expect(deriveCampaignMotionDialogState(state, "manual_broll")).toEqual({
      eligibleCount: 1,
      attentionCount: 1,
      canSubmit: true,
    });
  });

  test("builds brand, style, and scene requests from the same stable revision fences", () => {
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
    ).toEqual({
      profileFingerprint: fingerprint,
      styleFingerprint: null,
      clips,
    });
    expect(
      buildApplyStyleSelectedInput(
        templateId,
        fingerprint,
        selectedItems,
      ),
    ).toEqual({ templateId, templateFingerprint: fingerprint, clips });
    expect(
      buildApplySceneTemplateSelectedInput(
        fingerprint,
        "end",
        selectedItems,
      ),
    ).toEqual({ templateFingerprint: fingerprint, placement: "end", clips });
  });

  test("retries only failed or stale editor actions against current revision fences", () => {
    const fingerprint = "a".repeat(64);
    const retry = buildCampaignEditorRetryRequest({
      operation: {
        action: "apply_style",
        items: [
          { requestedClipId: "changed", status: "succeeded" },
          { requestedClipId: "same", status: "unchanged" },
          { requestedClipId: "blocked", status: "ineligible" },
          {
            requestedClipId: "old",
            expectedEditorRevision: 7,
            status: "stale",
          },
          {
            requestedClipId: "error",
            expectedEditorRevision: 9,
            status: "failed",
          },
        ],
      },
      intent: {
        action: "apply_style",
        templateId: "10000000-0000-4000-8000-000000000001",
        templateFingerprint: fingerprint,
      },
      selectedItems: [
        { clipId: "old", expectedEditorRevision: 12, hasManualBroll: false },
        { clipId: "error", expectedEditorRevision: 9, hasManualBroll: true },
        { clipId: "changed", expectedEditorRevision: 5, hasManualBroll: false },
        { clipId: "blocked", expectedEditorRevision: 4, hasManualBroll: false },
      ],
    });

    expect(retry).toEqual({
      action: "apply_style",
      input: {
        templateId: "10000000-0000-4000-8000-000000000001",
        templateFingerprint: fingerprint,
        clips: [
          { clipId: "old", expectedEditorRevision: 12 },
          { clipId: "error", expectedEditorRevision: 9 },
        ],
      },
    });
  });

  test("offers no retry for a mismatched action, missing selection, or ineligible-only result", () => {
    const common = {
      selectedItems: [
        { clipId: "a", expectedEditorRevision: 3, hasManualBroll: false },
      ],
      intent: {
        action: "apply_motion" as const,
        change: {
          scope: "clip_transition" as const,
          transition: { type: "fade" as const, durationSec: 0.4 },
        },
      },
    };

    expect(
      buildCampaignEditorRetryRequest({
        ...common,
        operation: {
          action: "apply_style",
          items: [{ requestedClipId: "a", status: "failed" }],
        },
      }),
    ).toBeNull();
    expect(
      buildCampaignEditorRetryRequest({
        ...common,
        operation: {
          action: "apply_motion",
          items: [{ requestedClipId: "missing", status: "failed" }],
        },
      }),
    ).toBeNull();
    expect(
      buildCampaignEditorRetryRequest({
        ...common,
        operation: {
          action: "apply_motion",
          items: [{ requestedClipId: "a", status: "ineligible" }],
        },
      }),
    ).toBeNull();
    expect(
      buildCampaignEditorRetryRequest({
        ...common,
        operation: {
          action: "apply_motion",
          items: [
            {
              requestedClipId: "a",
              expectedEditorRevision: 3,
              status: "stale",
            },
          ],
        },
      }),
    ).toBeNull();
  });
});
