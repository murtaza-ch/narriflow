import { describe, expect, test } from "bun:test";
import { finishingSettingsSchema } from "@narriflow/validators";
import { describeFinishing, draftFromFinishing, EMPTY_FINISHING_DRAFT, finishingFromDraft } from "./finishing-form";

describe("Finishing section of the Recipe form", () => {
  test("off means no finishing, and a Recipe with none opens off", () => {
    expect(finishingFromDraft(EMPTY_FINISHING_DRAFT)).toEqual({ settings: null });
    expect(draftFromFinishing(null)).toEqual(EMPTY_FINISHING_DRAFT);
  });

  test("a draft becomes the shared settings, and settings open as the same draft", () => {
    const draft = { enabled: true, topClips: "4", minScore: "55", aspectRatios: ["9:16" as const, "4:5" as const], copyPlatforms: ["tiktok" as const], delivery: "ready_to_review" as const, queueAccountIds: [] };
    const result = finishingFromDraft(draft);
    expect(result).toEqual({ settings: finishingSettingsSchema.parse({ topClips: 4, minScore: 55, aspectRatios: ["9:16", "4:5"], copyPlatforms: ["tiktok"] }) });
    if (!("settings" in result) || !result.settings) throw new Error("expected settings");
    expect(draftFromFinishing(result.settings)).toEqual(draft);
  });

  test("proposing to the queue keeps its accounts, and needs at least one", () => {
    const account = "00000000-0000-4000-8000-000000000001";
    const draft = { ...EMPTY_FINISHING_DRAFT, enabled: true, copyPlatforms: ["tiktok" as const], delivery: "propose_to_queue" as const, queueAccountIds: [account] };
    const result = finishingFromDraft(draft);
    expect(result).toEqual({ settings: finishingSettingsSchema.parse({ topClips: 3, aspectRatios: ["9:16"], copyPlatforms: ["tiktok"], delivery: "propose_to_queue", queueAccountIds: [account] }) });
    if (!("settings" in result) || !result.settings) throw new Error("expected settings");
    expect(draftFromFinishing(result.settings)).toMatchObject({ delivery: "propose_to_queue", queueAccountIds: [account] });
    expect(describeFinishing(result.settings, (platform) => platform)).toContain("proposed to 1 queue account");
    expect(finishingFromDraft({ ...draft, queueAccountIds: [] })).toEqual({ error: "Choose an account to propose posts to." });
    // Turning the queue off drops its accounts rather than saving settings the schema refuses.
    expect(finishingFromDraft({ ...draft, delivery: "ready_to_review" })).toEqual({ settings: finishingSettingsSchema.parse({ topClips: 3, aspectRatios: ["9:16"], copyPlatforms: ["tiktok"] }) });
  });

  test("sending a review round needs no accounts and is summarized as granted", () => {
    const draft = { ...EMPTY_FINISHING_DRAFT, enabled: true, delivery: "send_review_round" as const };
    const result = finishingFromDraft(draft);
    expect(result).toEqual({ settings: finishingSettingsSchema.parse({ topClips: 3, aspectRatios: ["9:16"], delivery: "send_review_round" }) });
    if (!("settings" in result) || !result.settings) throw new Error("expected settings");
    expect(draftFromFinishing(result.settings)).toMatchObject({ delivery: "send_review_round", queueAccountIds: [] });
    expect(describeFinishing(result.settings, (platform) => platform)).toContain("sent for review under a grant");
  });

  test("what the schema would refuse is explained before saving", () => {
    const on = { ...EMPTY_FINISHING_DRAFT, enabled: true };
    expect(finishingFromDraft({ ...on, topClips: "0" })).toEqual({ error: "Finish between 1 and 10 clips per video." });
    expect(finishingFromDraft({ ...on, topClips: "11" })).toEqual({ error: "Finish between 1 and 10 clips per video." });
    expect(finishingFromDraft({ ...on, topClips: "2.5" })).toEqual({ error: "Finish between 1 and 10 clips per video." });
    expect(finishingFromDraft({ ...on, minScore: "101" })).toEqual({ error: "Minimum score must be between 0 and 100." });
    expect(finishingFromDraft({ ...on, aspectRatios: [] })).toEqual({ error: "Choose at least one export format." });
  });

  test("a card line names the clips, score, formats and copy platforms", () => {
    const label = (platform: string) => platform.toUpperCase();
    expect(describeFinishing(finishingSettingsSchema.parse({ topClips: 1 }), label)).toBe("top 1 clip · 9:16");
    expect(describeFinishing(finishingSettingsSchema.parse({ topClips: 3, minScore: 70, aspectRatios: ["1:1"], copyPlatforms: ["tiktok", "x"] }), label)).toBe(
      "top 3 clips · score 70+ · 1:1 · copy for TIKTOK, X",
    );
  });
});
