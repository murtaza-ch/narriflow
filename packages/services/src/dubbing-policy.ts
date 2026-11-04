import { transcriptUtteranceSchema, type TranscriptUtterance } from "@narriflow/validators";
import { frozenDubbingRequestSchema, type FrozenDubbingRequest } from "@narriflow/validators/dubbing-execution";
import { sha256Hex } from "./execution-hash";

function languageRoot(code: string | null | undefined) { return code?.split("-")[0]?.toLowerCase() ?? null; }
export function shouldTranslateDub(sourceCode: string | null, targetCode: string) {
  const source = languageRoot(sourceCode), target = languageRoot(targetCode);
  return Boolean(target && source !== target);
}
export function dubLanguageLabel(code: string) {
  const labels: Record<string, string> = { ar: "Arabic", de: "German", en: "English", es: "Spanish", fr: "French", hi: "Hindi", it: "Italian", ja: "Japanese", ko: "Korean", nl: "Dutch", pt: "Portuguese", tr: "Turkish", ur: "Urdu", zh: "Chinese" };
  return labels[languageRoot(code) ?? ""] ?? code;
}
/** The same transcript policy is used when admitting and executing a Dub. */
export function buildDubTranscriptText(input: { transcriptSlice: unknown; hookText: string; payoffText: string | null }) {
  const parsed = transcriptUtteranceSchema.array().safeParse(input.transcriptSlice);
  const utterances: TranscriptUtterance[] = parsed.success ? parsed.data : [];
  const text = utterances.map(utterance => utterance.text.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (text) return text;
  return [input.hookText, input.payoffText].filter((value): value is string => Boolean(value?.trim())).join(" ").replace(/\s+/g, " ").trim();
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

export function dubTranslationRequestBody(input: Pick<FrozenDubbingRequest, "translationModel" | "script" | "sourceLanguageCode" | "targetLanguageCode">) {
  return { model: input.translationModel, input: [
    { role: "system", content: "Translate creator video transcripts for natural voiceover dubbing. Preserve meaning, names, numbers, and tone. Return only the translated script with no markdown or commentary." },
    { role: "user", content: `Source language: ${input.sourceLanguageCode ?? "auto"}\nTarget language: ${dubLanguageLabel(input.targetLanguageCode)} (${input.targetLanguageCode})\n\nSCRIPT:\n${input.script}` },
  ] };
}
export function dubSpeechRequestBody(input: Pick<FrozenDubbingRequest, "model" | "voice">, text: string) {
  return { model: input.model, voice: input.voice, input: text, response_format: "mp3" };
}
export const DUBBING_STAGE_OUTPUTS = {
  translation_intent: { role: "probe", contentType: "application/json", maxBytes: 65536 },
  translation_result: { role: "probe", contentType: "application/json", maxBytes: 1024 ** 2 },
  speech_intent: { role: "probe", contentType: "application/json", maxBytes: 65536 },
  audio: { role: "dub_mix", contentType: "audio/mpeg", maxBytes: 64 * 1024 ** 2 },
  video: { role: "dub_mix", contentType: "video/mp4", maxBytes: 10 * 1024 ** 3 },
  final_result: { role: "probe", contentType: "application/json", maxBytes: 65536 },
} as const;
export type DubbingArtifactStage = keyof typeof DUBBING_STAGE_OUTPUTS;
export async function dubbingArtifactBindingHash(requestHash: string, stage: DubbingArtifactStage) {
  const value = JSON.stringify({ version: 1, kind: "dubbing_artifact", requestHash, stage });
  return await sha256Hex(value);
}
