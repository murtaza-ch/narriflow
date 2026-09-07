import type { SceneContent } from "@narriflow/validators";

export interface SceneFontChoice {
  id: string;
  family: string;
  fingerprint: string;
  insertable: boolean;
  missing: boolean;
}

export function sceneFontPreviewFamily(font: Pick<SceneFontChoice, "id" | "fingerprint">) {
  return `NarriflowScene_${font.id.replaceAll("-", "_")}_${font.fingerprint.slice(0, 16)}`;
}

export function systemSceneFontPreviewFamily(family: string) {
  return family === "Archivo"
    ? "var(--font-display), Archivo, sans-serif"
    : "Arial, sans-serif";
}

export function sceneTextContent(
  text: string,
  fonts: readonly SceneFontChoice[],
): Extract<SceneContent, { kind: "text" }> {
  const font = fonts.find((candidate) => candidate.insertable && !candidate.missing);
  return {
    kind: "text",
    text,
    fontFamily: font?.family ?? "Archivo",
    fontAsset: font
      ? { kind: "brand_font", id: font.id, fingerprint: font.fingerprint }
      : null,
    color: "#FFFFFF",
    backgroundColor: "#111827",
  };
}
