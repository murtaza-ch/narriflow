import { afterEach, describe, expect, test } from "bun:test";

import { CampaignOperationService } from "./campaign-operation.service";
import { ProgramWriteDisabledError } from "./program-rollout";

const ENV_KEYS = [
  "NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS",
  "NARRIFLOW_WRITES_CAMPAIGN_RENDER",
  "NARRIFLOW_WRITES_CAMPAIGN_EXPORTS",
  "NARRIFLOW_WRITES_CAMPAIGN_CREATIVE",
  "NARRIFLOW_MOTION_SHADOW_LEGACY_TRANSITIONS",
  "NARRIFLOW_WRITES_MOTION_CROSS_DISSOLVE",
  "NARRIFLOW_WRITES_MOTION_DIRECTIONAL_WIPE",
  "NARRIFLOW_WRITES_MOTION_DIRECTIONAL_SLIDE",
  "NARRIFLOW_WRITES_MOTION_ZOOM",
  "NARRIFLOW_WRITES_MOTION_MEDIA_FADE_SCALE",
  "NARRIFLOW_WRITES_MOTION_PAN_KEN_BURNS",
  "NARRIFLOW_WRITES_MOTION_CAMPAIGN_APPLY",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Campaign Operation rollout admission", () => {
  test("keeps the existing Render selected path until its audit stage opens", async () => {
    process.env.NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS = "1";
    process.env.NARRIFLOW_WRITES_CAMPAIGN_RENDER = "0";
    const expected = {
      workflowRunId: "run-1",
      acceptedAt: "2026-08-31T12:00:00.000Z",
      initialSeq: 1,
      clipCount: 1,
      variantCount: 1,
      resolution: "1080p" as const,
    };

    const result = await new CampaignOperationService().renderSelected({
      actorUserId: "actor-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      pricingTier: "pro",
      idempotencyKey: "render-1",
      clipIds: ["clip-1"],
      resolution: "1080p",
      execute: async () => expected,
    });

    expect(result).toEqual(expected);
  });

  test("rejects Export Bundle admission before database access when its stage is closed", async () => {
    process.env.NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS = "1";
    process.env.NARRIFLOW_WRITES_CAMPAIGN_RENDER = "1";
    process.env.NARRIFLOW_WRITES_CAMPAIGN_EXPORTS = "0";

    await expect(
      new CampaignOperationService().createExportBundle(
        {
          actorUserId: "actor-1",
          workspaceId: "workspace-1",
          projectId: "project-1",
          pricingTier: "pro",
          idempotencyKey: "bundle-1",
        },
        {
          clips: [
            {
              clipId: "10000000-0000-4000-8000-000000000001",
              expectedEditorRevision: 1,
            },
          ],
          aspectRatios: ["9:16"],
          resolution: "1080p",
        },
      ),
    ).rejects.toBeInstanceOf(ProgramWriteDisabledError);
  });

  test("rejects creative document admission before authorization or database access", async () => {
    process.env.NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS = "1";
    process.env.NARRIFLOW_WRITES_CAMPAIGN_RENDER = "1";
    process.env.NARRIFLOW_WRITES_CAMPAIGN_EXPORTS = "1";
    process.env.NARRIFLOW_WRITES_CAMPAIGN_CREATIVE = "0";

    await expect(
      new CampaignOperationService().applyStyleSelected(
        {
          actorUserId: "actor-1",
          workspaceId: "workspace-1",
          workspaceOwnerUserId: "owner-1",
          projectId: "project-1",
          pricingTier: "pro",
          role: "owner",
          status: "active",
          isPersonalWorkspace: true,
          idempotencyKey: "style-1",
        },
        {},
      ),
    ).rejects.toBeInstanceOf(ProgramWriteDisabledError);
  });

  test("rejects direct selected-motion admission until the final Motion stage opens", async () => {
    process.env.NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS = "1";
    process.env.NARRIFLOW_WRITES_CAMPAIGN_RENDER = "1";
    process.env.NARRIFLOW_WRITES_CAMPAIGN_EXPORTS = "1";
    process.env.NARRIFLOW_WRITES_CAMPAIGN_CREATIVE = "1";
    process.env.NARRIFLOW_MOTION_SHADOW_LEGACY_TRANSITIONS = "1";
    process.env.NARRIFLOW_WRITES_MOTION_CROSS_DISSOLVE = "1";
    process.env.NARRIFLOW_WRITES_MOTION_DIRECTIONAL_WIPE = "1";
    process.env.NARRIFLOW_WRITES_MOTION_DIRECTIONAL_SLIDE = "1";
    process.env.NARRIFLOW_WRITES_MOTION_ZOOM = "1";
    process.env.NARRIFLOW_WRITES_MOTION_MEDIA_FADE_SCALE = "1";
    process.env.NARRIFLOW_WRITES_MOTION_PAN_KEN_BURNS = "1";
    process.env.NARRIFLOW_WRITES_MOTION_CAMPAIGN_APPLY = "0";

    await expect(
      new CampaignOperationService().applyMotionSelected(
        {
          actorUserId: "actor-1",
          workspaceId: "workspace-1",
          projectId: "project-1",
          pricingTier: "pro",
          role: "owner",
          status: "active",
          idempotencyKey: "motion-1",
        },
        {
          change: {
            scope: "clip_transition",
            transition: { type: "cross-dissolve", durationSec: 0.4 },
          },
          clips: [
            {
              clipId: "10000000-0000-4000-8000-000000000001",
              expectedEditorRevision: 1,
            },
          ],
        },
      ),
    ).rejects.toBeInstanceOf(ProgramWriteDisabledError);
  });
});
