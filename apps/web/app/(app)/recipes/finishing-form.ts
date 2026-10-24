import {
  finishingSettingsSchema,
  type ClipAspectRatio,
  type FinishingSettings,
  type SocialPlatform,
} from "@narriflow/validators";

/** The Finishing section of the Recipe form. Numbers stay strings
 * while the person types; `finishingFromDraft` turns them into the shared
 * settings, or says what to fix. */
export interface FinishingDraft {
  enabled: boolean;
  topClips: string;
  minScore: string;
  aspectRatios: ClipAspectRatio[];
  copyPlatforms: SocialPlatform[];
  delivery: FinishingSettings["delivery"];
  queueAccountIds: string[];
}

export const EMPTY_FINISHING_DRAFT: FinishingDraft = {
  enabled: false,
  topClips: "3",
  minScore: "0",
  aspectRatios: ["9:16"],
  copyPlatforms: [],
  delivery: "ready_to_review",
  queueAccountIds: [],
};

export function draftFromFinishing(settings: FinishingSettings | null): FinishingDraft {
  if (!settings) return EMPTY_FINISHING_DRAFT;
  return {
    enabled: true,
    topClips: String(settings.topClips),
    minScore: String(settings.minScore),
    aspectRatios: settings.aspectRatios ?? ["9:16"],
    copyPlatforms: settings.copyPlatforms,
    delivery: settings.delivery,
    queueAccountIds: settings.queueAccountIds,
  };
}

export function finishingFromDraft(draft: FinishingDraft): { settings: FinishingSettings | null } | { error: string } {
  if (!draft.enabled) return { settings: null };
  const topClips = Number(draft.topClips);
  if (!Number.isInteger(topClips) || topClips < 1 || topClips > 10) return { error: "Finish between 1 and 10 clips per video." };
  const minScore = Number(draft.minScore);
  if (!Number.isInteger(minScore) || minScore < 0 || minScore > 100) return { error: "Minimum score must be between 0 and 100." };
  if (draft.aspectRatios.length === 0) return { error: "Choose at least one export format." };
  if (draft.delivery === "propose_to_queue" && draft.queueAccountIds.length === 0) return { error: "Choose an account to propose posts to." };
  const parsed = finishingSettingsSchema.safeParse({
    topClips,
    minScore,
    aspectRatios: draft.aspectRatios,
    copyPlatforms: draft.copyPlatforms,
    delivery: draft.delivery,
    queueAccountIds: draft.delivery === "propose_to_queue" ? draft.queueAccountIds : [],
  });
  return parsed.success ? { settings: parsed.data } : { error: "Finishing settings are invalid." };
}

/** One line for a Recipe or rule card, such as "top 3 clips · 9:16 · copy for TikTok". */
export function describeFinishing(settings: FinishingSettings, platformLabel: (platform: SocialPlatform) => string): string {
  const parts = [`top ${settings.topClips} clip${settings.topClips === 1 ? "" : "s"}`];
  if (settings.minScore > 0) parts.push(`score ${settings.minScore}+`);
  parts.push((settings.aspectRatios ?? ["9:16"]).join(", "));
  if (settings.copyPlatforms.length > 0) parts.push(`copy for ${settings.copyPlatforms.map(platformLabel).join(", ")}`);
  if (settings.delivery === "propose_to_queue") parts.push(`proposed to ${settings.queueAccountIds.length} queue account${settings.queueAccountIds.length === 1 ? "" : "s"}`);
  if (settings.delivery === "send_review_round") parts.push("sent for review under a grant");
  return parts.join(" · ");
}
