import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  captionPresetIdSchema,
  clipLengthPresetRanges,
  contentPackSchema,
  sourceLanguageCodeFromFormValue,
  type CaptionPresetId,
  type ClipLengthPreset,
  type ClipPlatformTarget,
  type ContentPack,
  type GenerationMode,
} from "@narriflow/validators";

const defaultContentPack: ContentPack = {
  outputTypes: ["short_clip"],
  clipGenerationMode: "best",
  clipCountTarget: 10,
  clipDurationSecTarget: 45,
  minDurationSec: 15,
  preferredMinDurationSec: 30,
  preferredMaxDurationSec: 60,
  maxDurationSec: 90,
  platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
  autoRenderClips: false,
  toneConstraints: ["concise", "conversational"],
  captionPreset: BRAND_DEFAULT_CAPTION_PRESET_ID,
  platformPlaybookVersion: "2026.2",
  mode: "clip",
  autoHook: true,
  specificMoments: "",
  processingStartSec: null,
  processingEndSec: null,
  clipLengthPreset: "auto",
};

function readNumber(formData: FormData, key: string, fallback: number) {
  const raw = formData.get(key);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readNullableNumber(formData: FormData, key: string): number | null {
  const raw = formData.get(key);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function readPreset(formData: FormData): ClipLengthPreset {
  const raw = String(formData.get("clipLengthPreset") ?? "auto");
  if (
    raw === "auto" ||
    raw === "under_30s" ||
    raw === "30_to_60s" ||
    raw === "60_to_120s" ||
    raw === "120_to_180s"
  ) {
    return raw;
  }
  return "auto";
}

function readMode(formData: FormData): GenerationMode {
  return formData.get("mode") === "caption_only" ? "caption_only" : "clip";
}

function readBoolean(formData: FormData, key: string, fallback: boolean) {
  const raw = formData.get(key);
  if (raw === null) return fallback;
  return raw === "on" || raw === "true";
}

function readCaptionPreset(formData: FormData): CaptionPresetId {
  const raw = String(formData.get("captionPreset") ?? BRAND_DEFAULT_CAPTION_PRESET_ID);
  const parsed = captionPresetIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : BRAND_DEFAULT_CAPTION_PRESET_ID;
}

export function readContentPackFromForm(formData: FormData): ContentPack {
  const platformTargets = formData
    .getAll("platformTargets")
    .map((value) => String(value))
    .filter(Boolean) as ClipPlatformTarget[];
  const toneConstraints = String(formData.get("toneConstraints") ?? "")
    .split(",")
    .map((tone) => tone.trim())
    .filter(Boolean);

  const preset = readPreset(formData);
  const presetRange = clipLengthPresetRanges[preset];

  // When a non-auto preset is chosen, the preset values win.
  // When "auto" is chosen, we accept explicit numeric overrides if present
  // (used by the existing project-page Advanced panel power-user inputs).
  const useExplicit = preset === "auto";
  const clipDurationSecTarget = useExplicit
    ? readNumber(formData, "clipDurationSecTarget", presetRange.clipDurationSecTarget)
    : presetRange.clipDurationSecTarget;
  const minDurationSec = useExplicit
    ? readNumber(formData, "minDurationSec", presetRange.minDurationSec)
    : presetRange.minDurationSec;
  const preferredMinDurationSec = useExplicit
    ? readNumber(formData, "preferredMinDurationSec", presetRange.preferredMinDurationSec)
    : presetRange.preferredMinDurationSec;
  const preferredMaxDurationSec = useExplicit
    ? readNumber(formData, "preferredMaxDurationSec", presetRange.preferredMaxDurationSec)
    : presetRange.preferredMaxDurationSec;
  const maxDurationSec = useExplicit
    ? readNumber(formData, "maxDurationSec", presetRange.maxDurationSec)
    : presetRange.maxDurationSec;

  return contentPackSchema.parse({
    ...defaultContentPack,
    clipCountTarget: readNumber(
      formData,
      "clipCountTarget",
      defaultContentPack.clipCountTarget,
    ),
    clipDurationSecTarget,
    minDurationSec,
    preferredMinDurationSec,
    preferredMaxDurationSec,
    maxDurationSec,
    platformTargets:
      platformTargets.length > 0
        ? platformTargets
        : defaultContentPack.platformTargets,
    autoRenderClips: readBoolean(formData, "autoRenderClips", false),
    toneConstraints:
      toneConstraints.length > 0
        ? toneConstraints
        : defaultContentPack.toneConstraints,
    captionPreset: readCaptionPreset(formData),
    mode: readMode(formData),
    autoHook: readBoolean(formData, "autoHook", true),
    specificMoments: String(formData.get("specificMoments") ?? "").slice(0, 500),
    processingStartSec: readNullableNumber(formData, "processingStartSec"),
    processingEndSec: readNullableNumber(formData, "processingEndSec"),
    clipLengthPreset: preset,
  });
}

export function readLanguageCodeFromForm(
  formData: FormData,
): ReturnType<typeof sourceLanguageCodeFromFormValue> {
  return sourceLanguageCodeFromFormValue(formData.get("languageCode"));
}

export type UploadSettingsFormInput = {
  languageCode: string;
  mode: GenerationMode;
  clipLengthPreset: ClipLengthPreset;
  autoHook: boolean;
  specificMoments: string;
  processingStartSec: number | null;
  processingEndSec: number | null;
  captionPreset: CaptionPresetId;
  brandTemplateId: string | null;
  clipCountTarget: number;
  platformTargets: ClipPlatformTarget[];
  autoRenderClips: boolean;
  toneConstraints: string;
};

export function buildUploadSettingsFormData(input: UploadSettingsFormInput) {
  const formData = new FormData();
  formData.set("languageCode", input.languageCode);
  formData.set("mode", input.mode);
  formData.set("clipLengthPreset", input.clipLengthPreset);
  formData.set("captionPreset", input.captionPreset);
  if (input.autoHook) formData.set("autoHook", "on");
  formData.set("specificMoments", input.specificMoments);
  if (input.processingStartSec !== null) {
    formData.set("processingStartSec", String(input.processingStartSec));
  }
  if (input.processingEndSec !== null) {
    formData.set("processingEndSec", String(input.processingEndSec));
  }
  if (input.brandTemplateId) {
    formData.set("brandTemplateId", input.brandTemplateId);
  }
  formData.set("clipCountTarget", String(input.clipCountTarget));
  for (const target of input.platformTargets) {
    formData.append("platformTargets", target);
  }
  if (input.autoRenderClips) formData.set("autoRenderClips", "on");
  formData.set("toneConstraints", input.toneConstraints);
  return formData;
}

export function buildUploadGenerationContext(input: UploadSettingsFormInput) {
  const formData = buildUploadSettingsFormData(input);
  return {
    contentPack: readContentPackFromForm(formData),
    languageCode: readLanguageCodeFromForm(formData),
  };
}
