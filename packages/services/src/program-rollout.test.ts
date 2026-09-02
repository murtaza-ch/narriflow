import { describe, expect, test } from "bun:test";
import {
  assertProgramWriteEnabled,
  campaignActionRolloutFromEnv,
  isProgramWriteEnabled,
  ProgramWriteDisabledError,
  reviewRoomRolloutFromEnv,
} from "./program-rollout";

describe("program rollout controls", () => {
  test("keeps guest review access available when new round creation is paused", () => {
    expect(
      reviewRoomRolloutFromEnv({
        NARRIFLOW_WRITES_REVIEW_ROOMS: "0",
        NARRIFLOW_READS_REVIEW_GUEST: "1",
        NARRIFLOW_WRITES_REVIEW_FEEDBACK: "1",
        NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS: "1",
      }),
    ).toEqual({
      internalCreation: false,
      guestRead: true,
      feedback: true,
      notifications: true,
    });
  });

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

  test("opens campaign stages in order while keeping unfinished targets hidden", () => {
    expect(
      campaignActionRolloutFromEnv({
        NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS: "1",
        NARRIFLOW_WRITES_CAMPAIGN_RENDER: "1",
        NARRIFLOW_WRITES_CAMPAIGN_EXPORTS: "1",
        NARRIFLOW_WRITES_CAMPAIGN_CREATIVE: "1",
        NARRIFLOW_WRITES_CAMPAIGN_REVIEW: "1",
        NARRIFLOW_WRITES_CAMPAIGN_SCHEDULING: "1",
      }),
    ).toEqual({
      render: true,
      exports: true,
      creative: true,
      review: false,
      scheduling: false,
    });
    expect(
      campaignActionRolloutFromEnv({
        NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS: "1",
        NARRIFLOW_WRITES_CAMPAIGN_CREATIVE: "1",
      }),
    ).toMatchObject({ render: false, exports: false, creative: false });
  });
});
