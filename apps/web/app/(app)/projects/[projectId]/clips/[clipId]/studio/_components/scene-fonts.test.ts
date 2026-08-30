import { describe, expect, test } from "bun:test";
import {
  sceneFontPreviewFamily,
  sceneTextContent,
  systemSceneFontPreviewFamily,
} from "./scene-fonts";

describe("Scene font preview identity", () => {
  test("keeps same-family frozen files isolated by id and fingerprint", () => {
    const first = sceneFontPreviewFamily({
      id: "11111111-1111-4111-8111-111111111111",
      fingerprint: "a".repeat(64),
    });
    const second = sceneFontPreviewFamily({
      id: "22222222-2222-4222-8222-222222222222",
      fingerprint: "b".repeat(64),
    });
    expect(first).not.toBe(second);
    expect(first).toContain("aaaaaaaaaaaaaaaa");
  });

  test("maps the system Archivo contract to Next's loaded display face", () => {
    expect(systemSceneFontPreviewFamily("Archivo")).toContain("--font-display");
    expect(systemSceneFontPreviewFamily("Arial")).toBe("Arial, sans-serif");
  });

  test("uses the active insertable Brand font for every text-card insertion", () => {
    expect(sceneTextContent("Opening", [{
      id: "11111111-1111-4111-8111-111111111111",
      family: "Acme Display",
      fingerprint: "a".repeat(64),
      insertable: true,
      missing: false,
    }])).toMatchObject({
      fontFamily: "Acme Display",
      fontAsset: { id: "11111111-1111-4111-8111-111111111111" },
    });
    expect(sceneTextContent("Opening", [])).toMatchObject({
      fontFamily: "Archivo",
      fontAsset: null,
    });
  });
});
