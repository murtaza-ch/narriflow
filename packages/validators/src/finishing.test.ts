import { describe, expect, test } from "bun:test";
import { autopilotRuleInputSchema, autopilotRuleUpdateSchema } from "./autopilot";
import { recipeInputSchema, recipeUpdateSchema } from "./recipe";

const RECIPE_ID = "00000000-0000-4000-8000-0000000000e1";
import { finishingReasonMessage, finishingSettingsSchema, freezeFinishingSettings } from "./finishing";
import { buildGenerationContext, buildGenerationContentPack, generationSettingsSchema } from "./integration";
import { generateProjectRequestSchema } from "./project";
import { mcpGenerateClipsSchema, mcpSubmitVideoSchema, mcpUploadVideoSchema } from "./mcp";
import { generateClipsRequestSchema, openUploadRequestSchema, submitVideoRequestSchema } from "./rest-api";
import { openUploadSessionSchema } from "./upload";

describe("finishingSettingsSchema", () => {
  test("fills the defaults and leaves the formats to the generation", () => {
    expect(finishingSettingsSchema.parse({ topClips: 3 })).toEqual({
      topClips: 3,
      minScore: 0,
      resolution: "1080p",
      copyPlatforms: [],
      delivery: "ready_to_review",
      queueAccountIds: [],
    });
  });

  test("refuses settings outside the contract", () => {
    for (const invalid of [
      { topClips: 0 },
      { topClips: 11 },
      { topClips: 2.5 },
      { topClips: 3, minScore: 101 },
      { topClips: 3, minScore: -1 },
      { topClips: 3, aspectRatios: [] },
      { topClips: 3, aspectRatios: ["9:16", "9:16"] },
      { topClips: 3, aspectRatios: ["9:16", "1:1", "16:9", "4:5", "9:16"] },
      { topClips: 3, aspectRatios: ["2:1"] },
      { topClips: 3, resolution: "4k" },
      { topClips: 3, copyPlatforms: ["tiktok", "tiktok"] },
      { topClips: 3, copyPlatforms: ["myspace"] },
      { topClips: 3, delivery: "post_now" },
      { topClips: 3, delivery: "propose_to_queue" },
      { topClips: 3, delivery: "propose_to_queue", queueAccountIds: ["not-a-uuid"] },
      { topClips: 3, delivery: "ready_to_review", queueAccountIds: ["00000000-0000-4000-8000-000000000001"] },
      { topClips: 3, delivery: "propose_to_queue", queueAccountIds: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"] },
      { topClips: 3, dubbing: true },
      {},
    ]) {
      expect(finishingSettingsSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test("queue delivery names the accounts a finished clip is proposed to", () => {
    const accountId = "00000000-0000-4000-8000-000000000001";
    expect(finishingSettingsSchema.parse({ topClips: 2, delivery: "propose_to_queue", queueAccountIds: [accountId] })).toMatchObject({
      delivery: "propose_to_queue",
      queueAccountIds: [accountId],
    });
    expect(freezeFinishingSettings(finishingSettingsSchema.parse({ topClips: 2, delivery: "propose_to_queue", queueAccountIds: [accountId] }), "9:16").queueAccountIds).toEqual([accountId]);
  });

  test("freezing resolves an omitted format to the generation's default ratio", () => {
    const settings = finishingSettingsSchema.parse({ topClips: 2, copyPlatforms: ["tiktok", "x"] });
    expect(freezeFinishingSettings(settings, "1:1").aspectRatios).toEqual(["1:1"]);
    const chosen = finishingSettingsSchema.parse({ topClips: 2, aspectRatios: ["16:9", "9:16"] });
    expect(freezeFinishingSettings(chosen, "1:1").aspectRatios).toEqual(["16:9", "9:16"]);
  });

  test("reason codes read as plain sentences, and unknown codes stay generic", () => {
    expect(finishingReasonMessage(null)).toBeNull();
    expect(finishingReasonMessage("plan_required")).toContain("Pro");
    expect(finishingReasonMessage("something_new")).toBe("Finishing did not complete.");
  });
});

describe("finishing on every entry point", () => {
  const finishing = { topClips: 3, copyPlatforms: ["tiktok"] };
  const key = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "00000000-0000-4000-8000-000000000002";

  test("REST and MCP intake and generation accept it and refuse an invalid one", () => {
    expect(submitVideoRequestSchema.parse({ url: "https://youtu.be/x", finishing }).finishing?.topClips).toBe(3);
    expect(generateClipsRequestSchema.parse({ finishing }).finishing?.minScore).toBe(0);
    expect(openUploadRequestSchema.parse({ file: { name: "a.mp4", sizeBytes: 10, contentType: "video/mp4" }, finishing }).finishing?.topClips).toBe(3);
    expect(mcpSubmitVideoSchema.parse({ workspaceId, clientIdempotencyKey: key, url: "https://youtu.be/x", finishing }).finishing?.topClips).toBe(3);
    expect(mcpUploadVideoSchema.parse({ workspaceId, clientIdempotencyKey: key, finishing }).finishing?.topClips).toBe(3);
    expect(mcpGenerateClipsSchema.parse({ workspaceId, clientIdempotencyKey: key, projectId: key, finishing }).finishing?.topClips).toBe(3);
    expect(submitVideoRequestSchema.safeParse({ url: "https://youtu.be/x", finishing: { topClips: 99 } }).success).toBe(false);
    expect(mcpGenerateClipsSchema.safeParse({ workspaceId, clientIdempotencyKey: key, projectId: key, finishing: { topClips: 0 } }).success).toBe(false);
  });

  test("the browser's generate request takes no finishing, so it can never key a row to the wrong run", () => {
    const parsed = generateProjectRequestSchema.parse({ contentPack: buildGenerationContentPack(), finishing });
    expect("finishing" in parsed).toBe(false);
  });

  test("the generation context carries finishing only when asked for, so the Upload Session freezes it", () => {
    const settings = generationSettingsSchema.parse({});
    expect(buildGenerationContext(settings)).toEqual({ contentPack: buildGenerationContentPack(settings), languageCode: null });
    const withFinishing = buildGenerationContext(settings, { topClips: 2 });
    expect(withFinishing.finishing).toMatchObject({ topClips: 2, minScore: 0 });
    expect(openUploadSessionSchema.safeParse({
      clientIdempotencyKey: key, title: "Upload",
      source: { fileName: "a.mp4", sizeBytes: 10, contentType: "video/mp4", browserFingerprint: "f" },
      generationContext: withFinishing,
    }).success).toBe(true);
  });

  test("a Recipe saves finishing, clears it with null, and refuses an invalid one; an Autopilot rule no longer carries it", () => {
    const recipe = { name: "Show", contentPack: buildGenerationContentPack() };
    expect(recipeInputSchema.parse({ ...recipe, finishing }).finishing?.copyPlatforms).toEqual(["tiktok"]);
    expect(recipeInputSchema.parse(recipe).finishing).toBeUndefined();
    expect(recipeUpdateSchema.parse({ expectedRevision: 1, finishing: null })).toEqual({ expectedRevision: 1, finishing: null });
    expect(recipeInputSchema.safeParse({ ...recipe, finishing: { topClips: 20 } }).success).toBe(false);
    expect(recipeUpdateSchema.safeParse({ expectedRevision: 1, finishing: { minScore: 5 } }).success).toBe(false);
    expect(autopilotRuleInputSchema.safeParse({ name: "Show", rssUrl: "https://feeds.example.test/show.xml", recipeId: RECIPE_ID, finishing }).success).toBe(false);
    expect(autopilotRuleUpdateSchema.safeParse({ finishing: null }).success).toBe(false);
  });
});
