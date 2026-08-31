import { describe, expect, test } from "bun:test";
import {
  assertProgramWriteEnabled,
  assertCampaignActionWriteEnabled,
  assertPublishingPreparationWriteEnabled,
  autoCensorTreatmentWriteEnabled,
  autoCensorRolloutFromEnv,
  campaignActionRolloutFromEnv,
  isProgramWriteEnabled,
  motionRolloutFromEnv,
  ProgramWriteDisabledError,
  publishingPreparationRolloutFromEnv,
  sceneMotionWriteEnabled,
  studioTransitionWriteEnabled,
} from "./program-rollout";

describe("program rollout controls", () => {
  test("defaults to fail-closed writes while keeping reads available", () => {
    expect(isProgramWriteEnabled("brand_profiles", {})).toBe(false);
    expect(() => assertProgramWriteEnabled("brand_profiles", {})).toThrow(
      ProgramWriteDisabledError,
    );
  });

  test("enables only the named release group", () => {
    const env = { NARRIFLOW_WRITES_BRAND_PROFILES: "1" };
    expect(isProgramWriteEnabled("brand_profiles", env)).toBe(true);
    expect(isProgramWriteEnabled("visual_assets", env)).toBe(false);
  });

  test("opens Auto Censor in scan, caption-mask, mute, then beep order", () => {
    expect(
      autoCensorRolloutFromEnv({
        NARRIFLOW_WRITES_CENSOR_SCAN: "1",
        NARRIFLOW_WRITES_CENSOR_CAPTION_MASK: "1",
        NARRIFLOW_WRITES_CENSOR_MUTE: "0",
        NARRIFLOW_WRITES_CENSOR_BEEP: "1",
      }),
    ).toEqual({
      scan: true,
      captionMask: true,
      mute: false,
      beep: false,
      freePreviewLimit: 10,
    });

    expect(
      autoCensorRolloutFromEnv({
        NARRIFLOW_WRITES_CENSOR_SCAN: "1",
        NARRIFLOW_WRITES_CENSOR_CAPTION_MASK: "1",
        NARRIFLOW_WRITES_CENSOR_MUTE: "1",
        NARRIFLOW_WRITES_CENSOR_BEEP: "1",
      }),
    ).toMatchObject({
      scan: true,
      captionMask: true,
      mute: true,
      beep: true,
    });
  });

  test("opens motion families in render-parity order, with zoom explicit", () => {
    expect(
      motionRolloutFromEnv({
        NARRIFLOW_MOTION_SHADOW_LEGACY_TRANSITIONS: "1",
        NARRIFLOW_WRITES_MOTION_CROSS_DISSOLVE: "1",
        NARRIFLOW_WRITES_MOTION_DIRECTIONAL_WIPE: "1",
        NARRIFLOW_WRITES_MOTION_DIRECTIONAL_SLIDE: "0",
        NARRIFLOW_WRITES_MOTION_ZOOM: "1",
        NARRIFLOW_WRITES_MOTION_MEDIA_FADE_SCALE: "1",
        NARRIFLOW_WRITES_MOTION_PAN_KEN_BURNS: "1",
        NARRIFLOW_WRITES_MOTION_CAMPAIGN_APPLY: "1",
      }),
    ).toEqual({
      legacyTransitions: true,
      crossDissolve: true,
      directionalWipe: true,
      directionalSlide: false,
      zoom: false,
      mediaFadeScale: false,
      panKenBurns: false,
      campaignApply: false,
    });
  });

  test("opens Campaign actions in order and combines delivery with target controls", () => {
    expect(
      campaignActionRolloutFromEnv({
        NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS: "1",
        NARRIFLOW_WRITES_CAMPAIGN_RENDER: "1",
        NARRIFLOW_WRITES_CAMPAIGN_EXPORTS: "1",
        NARRIFLOW_WRITES_CAMPAIGN_CREATIVE: "1",
        NARRIFLOW_WRITES_CAMPAIGN_DELIVERY: "0",
        NARRIFLOW_WRITES_REVIEW_ROOMS: "1",
        NARRIFLOW_WRITES_BULK_SCHEDULING: "1",
      }),
    ).toEqual({
      render: true,
      exports: true,
      creative: true,
      delivery: false,
      review: false,
      scheduling: false,
    });

    expect(
      campaignActionRolloutFromEnv({
        NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS: "1",
        NARRIFLOW_WRITES_CAMPAIGN_RENDER: "1",
        NARRIFLOW_WRITES_CAMPAIGN_EXPORTS: "1",
        NARRIFLOW_WRITES_CAMPAIGN_CREATIVE: "1",
        NARRIFLOW_WRITES_CAMPAIGN_DELIVERY: "1",
        NARRIFLOW_WRITES_REVIEW_ROOMS: "0",
        NARRIFLOW_WRITES_ASSISTED_COPY: "1",
        NARRIFLOW_WRITES_THUMBNAIL_EXTRACTION: "1",
        NARRIFLOW_WRITES_BULK_SCHEDULING: "1",
      }),
    ).toEqual({
      render: true,
      exports: true,
      creative: true,
      delivery: true,
      review: false,
      scheduling: true,
    });
  });

  test("maps each censor treatment to its own released stage", () => {
    const rollout = autoCensorRolloutFromEnv({
      NARRIFLOW_WRITES_CENSOR_SCAN: "1",
      NARRIFLOW_WRITES_CENSOR_CAPTION_MASK: "1",
      NARRIFLOW_WRITES_CENSOR_MUTE: "0",
      NARRIFLOW_WRITES_CENSOR_BEEP: "1",
    });

    expect(autoCensorTreatmentWriteEnabled("caption_mask", rollout)).toBe(true);
    expect(autoCensorTreatmentWriteEnabled("mute", rollout)).toBe(false);
    expect(autoCensorTreatmentWriteEnabled("beep", rollout)).toBe(false);
  });

  test("maps transition and media vocabularies to explicit motion stages", () => {
    const rollout = motionRolloutFromEnv({
      NARRIFLOW_MOTION_SHADOW_LEGACY_TRANSITIONS: "1",
      NARRIFLOW_WRITES_MOTION_CROSS_DISSOLVE: "1",
      NARRIFLOW_WRITES_MOTION_DIRECTIONAL_WIPE: "1",
      NARRIFLOW_WRITES_MOTION_DIRECTIONAL_SLIDE: "1",
      NARRIFLOW_WRITES_MOTION_ZOOM: "0",
      NARRIFLOW_WRITES_MOTION_MEDIA_FADE_SCALE: "1",
      NARRIFLOW_WRITES_MOTION_PAN_KEN_BURNS: "1",
    });

    expect(studioTransitionWriteEnabled("slide-down", rollout)).toBe(true);
    expect(studioTransitionWriteEnabled("zoom-in", rollout)).toBe(false);
    expect(studioTransitionWriteEnabled("none", rollout)).toBe(true);
    expect(
      sceneMotionWriteEnabled({ entrance: "fade", exit: "scale-out" }, rollout),
    ).toBe(false);
    expect(
      sceneMotionWriteEnabled({ entrance: "none", exit: "none" }, rollout),
    ).toBe(true);
  });

  test("fails closed for feature vocabulary that has no explicit stage", () => {
    const fullyOpen = motionRolloutFromEnv({
      NARRIFLOW_MOTION_SHADOW_LEGACY_TRANSITIONS: "1",
      NARRIFLOW_WRITES_MOTION_CROSS_DISSOLVE: "1",
      NARRIFLOW_WRITES_MOTION_DIRECTIONAL_WIPE: "1",
      NARRIFLOW_WRITES_MOTION_DIRECTIONAL_SLIDE: "1",
      NARRIFLOW_WRITES_MOTION_ZOOM: "1",
      NARRIFLOW_WRITES_MOTION_MEDIA_FADE_SCALE: "1",
      NARRIFLOW_WRITES_MOTION_PAN_KEN_BURNS: "1",
      NARRIFLOW_WRITES_MOTION_CAMPAIGN_APPLY: "1",
    });

    expect(studioTransitionWriteEnabled("spin" as never, fullyOpen)).toBe(false);
    expect(
      sceneMotionWriteEnabled(
        { entrance: "bounce" as never, exit: "none" },
        fullyOpen,
      ),
    ).toBe(false);
    expect(
      autoCensorTreatmentWriteEnabled("blur" as never, {
        scan: true,
        captionMask: true,
        mute: true,
        beep: true,
        freePreviewLimit: 10,
      }),
    ).toBe(false);
  });

  test("rejects direct Campaign mutations whose ordered stage is closed", () => {
    const rollout = campaignActionRolloutFromEnv({
      NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS: "1",
      NARRIFLOW_WRITES_CAMPAIGN_RENDER: "1",
      NARRIFLOW_WRITES_CAMPAIGN_EXPORTS: "0",
      NARRIFLOW_WRITES_CAMPAIGN_CREATIVE: "1",
    });

    expect(() =>
      assertCampaignActionWriteEnabled("render_selected", rollout),
    ).not.toThrow();
    expect(() =>
      assertCampaignActionWriteEnabled("export_bundle", rollout),
    ).toThrow(ProgramWriteDisabledError);
    expect(() =>
      assertCampaignActionWriteEnabled("apply_style", rollout),
    ).toThrow(ProgramWriteDisabledError);
  });

  test("opens publishing preparation in copy, thumbnail, then bulk order", () => {
    expect(
      publishingPreparationRolloutFromEnv({
        NARRIFLOW_WRITES_ASSISTED_COPY: "1",
        NARRIFLOW_WRITES_THUMBNAIL_EXTRACTION: "0",
        NARRIFLOW_WRITES_BULK_SCHEDULING: "1",
      }),
    ).toEqual({
      assistedCopy: true,
      thumbnailExtraction: false,
      bulkScheduling: false,
    });

    expect(
      publishingPreparationRolloutFromEnv({
        NARRIFLOW_WRITES_ASSISTED_COPY: "1",
        NARRIFLOW_WRITES_THUMBNAIL_EXTRACTION: "1",
        NARRIFLOW_WRITES_BULK_SCHEDULING: "1",
      }),
    ).toEqual({
      assistedCopy: true,
      thumbnailExtraction: true,
      bulkScheduling: true,
    });

    expect(() =>
      assertPublishingPreparationWriteEnabled(
        "bulk_scheduling",
        publishingPreparationRolloutFromEnv({
          NARRIFLOW_WRITES_ASSISTED_COPY: "1",
          NARRIFLOW_WRITES_THUMBNAIL_EXTRACTION: "0",
          NARRIFLOW_WRITES_BULK_SCHEDULING: "1",
        }),
      ),
    ).toThrow(ProgramWriteDisabledError);
  });
});
