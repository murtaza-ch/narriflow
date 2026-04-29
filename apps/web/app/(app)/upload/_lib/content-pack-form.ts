import {
  clipLengthPresetRanges,
  contentPackSchema,
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
  captionPreset: "default",
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
): string | null {
  const raw = String(formData.get("languageCode") ?? "").trim();
  if (!raw || raw === "auto") return null;
  return raw;
}
