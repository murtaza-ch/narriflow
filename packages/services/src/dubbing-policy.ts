import { transcriptUtteranceSchema, type TranscriptUtterance } from "@narriflow/validators";
import { frozenDubbingRequestSchema, type FrozenDubbingRequest } from "@narriflow/validators/dubbing-execution";

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
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function frozenDubbingRequestHash(value: FrozenDubbingRequest) {
  const bytes = new TextEncoder().encode(canonical(frozenDubbingRequestSchema.parse(value)));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
