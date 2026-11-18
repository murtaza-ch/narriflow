import type { DubVideo } from "@narriflow/validators";
import { frozenDubbingRequestSchema, type FrozenDubbingRequest } from "@narriflow/validators/dubbing-execution";
import { sha256Hex } from "./execution-hash";
import { OPENAI_TEXT_REASONING } from "./openai-models";

function languageRoot(code: string | null | undefined) { return code?.split("-")[0]?.toLowerCase() ?? null; }
export function shouldTranslateDub(sourceCode: string | null, targetCode: string) {
  const source = languageRoot(sourceCode), target = languageRoot(targetCode);
  return Boolean(target && source !== target);
}
export function dubLanguageLabel(code: string) {
  const labels: Record<string, string> = { ar: "Arabic", de: "German", en: "English", es: "Spanish", fr: "French", hi: "Hindi", it: "Italian", ja: "Japanese", ko: "Korean", nl: "Dutch", pt: "Portuguese", tr: "Turkish", ur: "Urdu", zh: "Chinese" };
  return labels[languageRoot(code) ?? ""] ?? code;
}
export function canonicalDubbingJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDubbingJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalDubbingJson(Reflect.get(value, key))}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function frozenDubbingRequestHash(value: FrozenDubbingRequest) {
  const bytes = new TextEncoder().encode(canonicalDubbingJson(frozenDubbingRequestSchema.parse(value)));
  return await sha256Hex(bytes);
}

/** Seconds a segment gets to be spoken, rounded to 0.1 for the prompt. */
export function dubSegmentSeconds(segment: { startSec: number; endSec: number }) { return Math.round((segment.endSec - segment.startSec) * 10) / 10; }
const DUB_TRANSLATION_SCHEMA = { type: "object", additionalProperties: false, required: ["segments"], properties: { segments: { type: "array",
  items: { type: "object", additionalProperties: false, required: ["id", "text"], properties: { id: { type: "integer" }, text: { type: "string" } } } } } } as const;
/** Ids are 1-based positions in the frozen segment list. */
export function dubTranslationInput(segments: FrozenDubbingRequest["segments"]) {
  return segments.map((segment, index) => ({ id: index + 1, text: segment.text, seconds: dubSegmentSeconds(segment) }));
}
export function dubTranslationRequestBody(input: Pick<FrozenDubbingRequest, "translationModel" | "segments" | "sourceLanguageCode" | "targetLanguageCode">) {
  return { model: input.translationModel, reasoning: OPENAI_TEXT_REASONING, input: [
    { role: "system", content: "Translate creator video lines for natural voiceover dubbing. Keep each translated line speakable within its seconds at a natural pace, shortening phrasing rather than rushing. Preserve meaning, names, numbers, and tone. Return every id once, in the same order, with only the translated line: no markdown or commentary." },
    { role: "user", content: `Source language: ${input.sourceLanguageCode ?? "auto"}\nTarget language: ${dubLanguageLabel(input.targetLanguageCode)} (${input.targetLanguageCode})\n\nLINES:\n${JSON.stringify(dubTranslationInput(input.segments))}` },
  ], text: { format: { type: "json_schema", name: "dub_translation", strict: true, schema: DUB_TRANSLATION_SCHEMA } } };
}
/** The provider's translation must list the same ids in the same order with non-empty lines. */
export function parseDubTranslation(value: unknown, segments: FrozenDubbingRequest["segments"]): string[] | null {
  const lines = value && typeof value === "object" ? (value as { segments?: unknown }).segments : null;
  if (!Array.isArray(lines) || lines.length !== segments.length) return null;
  const texts: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line || typeof line !== "object") return null;
    const { id, text } = line as { id?: unknown; text?: unknown };
    if (id !== index + 1 || typeof text !== "string" || !text.trim() || text.trim().length > 20_000 || text.includes("\0")) return null;
    texts.push(text.trim());
  }
  return texts;
}
export function dubSpeechRequestBody(input: Pick<FrozenDubbingRequest, "model" | "voice">, text: string) {
  return { model: input.model, voice: input.voice, input: text, response_format: "mp3" };
}
/** One speech_intent covers every per-segment body, in segment order. */
export async function dubSpeechIntentHash(input: Pick<FrozenDubbingRequest, "model" | "voice">, texts: readonly string[]) {
  return await sha256Hex(JSON.stringify(texts.map(text => dubSpeechRequestBody(input, text))));
}
export const DUBBING_STAGE_OUTPUTS = {
  translation_intent: { role: "probe", contentType: "application/json", maxBytes: 65536 },
  translation_result: { role: "probe", contentType: "application/json", maxBytes: 1024 ** 2 },
  speech_intent: { role: "probe", contentType: "application/json", maxBytes: 65536 },
  timing: { role: "probe", contentType: "application/json", maxBytes: 1024 ** 2 },
  audio: { role: "dub_mix", contentType: "audio/mpeg", maxBytes: 64 * 1024 ** 2 },
  final_result: { role: "probe", contentType: "application/json", maxBytes: 65536 },
} as const;
export type DubbingArtifactStage = keyof typeof DUBBING_STAGE_OUTPUTS;
export async function dubbingArtifactBindingHash(requestHash: string, stage: DubbingArtifactStage) {
  const value = JSON.stringify({ version: 1, kind: "dubbing_artifact", requestHash, stage });
  return await sha256Hex(value);
}

const TIMING_SLACK_SEC = 1e-6;
/** Placed segments, in request order, inside the edited timeline, each with ordered words inside it. */
export function dubTimingMatchesRequest(timing: ReadonlyArray<{ startSec: number; endSec: number; words: ReadonlyArray<{ startSec: number; endSec: number }> }>, request: Pick<FrozenDubbingRequest, "segments" | "editedDurationSec">) {
  if (timing.length !== request.segments.length) return false;
  let previousEnd = 0;
  for (const segment of timing) {
    if (segment.startSec < previousEnd - TIMING_SLACK_SEC || segment.endSec < segment.startSec || segment.endSec > request.editedDurationSec + TIMING_SLACK_SEC) return false;
    let cursor = segment.startSec;
    for (const word of segment.words) {
      if (word.startSec < cursor - TIMING_SLACK_SEC || word.endSec < word.startSec || word.endSec > segment.endSec + TIMING_SLACK_SEC) return false;
      cursor = word.endSec;
    }
    previousEnd = segment.endSec;
  }
  return true;
}

/** What a dub row needs to say where its video stands. */
export interface DubVideoSource {
  status: string;
  videoErrorCode: string | null;
  export: {
    status: string;
    errorCode: string | null;
    variants: ReadonlyArray<{ status: string; storageKey: string | null; sizeBytes: bigint | number | null; errorCode: string | null }>;
  } | null;
}

/**
 * The dub's video is its dub-bound export: its aggregate status once one exists,
 * otherwise the admission code that kept it from starting. A dub that has not
 * completed has no video.
 */
export function dubVideoState(dub: DubVideoSource): { video: DubVideo; storageKey: string | null; sizeBytes: bigint | number | null } {
  const none = { video: { status: "none", errorCode: null } satisfies DubVideo, storageKey: null, sizeBytes: null };
  if (dub.status !== "completed") return none;
  const exported = dub.export;
  if (!exported) {
    return dub.videoErrorCode ? { ...none, video: { status: "failed", errorCode: dub.videoErrorCode } } : none;
  }
  const variant = exported.variants[0];
  if (exported.status === "failed") {
    return { ...none, video: { status: "failed", errorCode: exported.errorCode ?? variant?.errorCode ?? null } };
  }
  if ((exported.status === "ready" || exported.status === "partial_ready") && variant?.status === "completed" && variant.storageKey) {
    return { video: { status: "ready", errorCode: null }, storageKey: variant.storageKey, sizeBytes: variant.sizeBytes };
  }
  return { ...none, video: { status: "rendering", errorCode: null } };
}
