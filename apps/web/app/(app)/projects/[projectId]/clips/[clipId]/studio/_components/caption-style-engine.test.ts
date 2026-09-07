import { describe, expect, test } from "bun:test";
import { CAPTION_PRESETS } from "@narriflow/validators";
import { resolveCaptionFontWeight, warmCaptionFonts } from "./caption-style-engine";

// ─── resolveCaptionFontWeight ───────────────────────────────────────────────
//
// Regression coverage for the preview/export weight mismatch: layout.tsx
// only registers weights 400 and 700 per caption family (CSS collapses any
// other value to the nearest one — "900"/"600" both became 700), and the
// worker's libass force_style sets Bold=1/Bold=0, which render as 700/400.
// The two presets with bold:false used to preview bold (both "900" and "600"
// resolve to 700 in-browser) while burning in at regular weight.

describe("resolveCaptionFontWeight", () => {
  test("bold presets resolve to the loaded 700 weight", () => {
    expect(resolveCaptionFontWeight(true)).toBe("700");
  });

  test("non-bold presets resolve to the loaded 400 weight, not an unloaded one", () => {
    expect(resolveCaptionFontWeight(false)).toBe("400");
  });

  test("pins the two real presets the defect named (minimal, pastel-cloud)", () => {
    const minimal = CAPTION_PRESETS.find((preset) => preset.id === "minimal");
    const pastelCloud = CAPTION_PRESETS.find((preset) => preset.id === "pastel-cloud");
    expect(minimal?.preset.bold).toBe(false);
    expect(pastelCloud?.preset.bold).toBe(false);

    expect(resolveCaptionFontWeight(minimal!.preset.bold)).toBe("400");
    expect(resolveCaptionFontWeight(pastelCloud!.preset.bold)).toBe("400");
  });

  test("every other shipped preset is bold and resolves to 700", () => {
    const nonBoldIds = new Set(["minimal", "pastel-cloud"]);
    for (const named of CAPTION_PRESETS) {
      if (nonBoldIds.has(named.id)) continue;
      expect(named.preset.bold).toBe(true);
      expect(resolveCaptionFontWeight(named.preset.bold)).toBe("700");
    }
  });
});

// ─── warmCaptionFonts ────────────────────────────────────────────────────────
//
// Mirrors the six families/weights layout.tsx registers as CSS variables on
// <html>. Deliberately duplicated here (rather than imported) since the
// source map is module-private — a rename on one side without the other is
// exactly the kind of drift this test should catch.
const FAKE_RESOLVED_FAMILIES: Record<string, string> = {
  "--font-caption-montserrat": "'__Montserrat_test', '__Montserrat_Fallback_test'",
  "--font-caption-bebas-neue": "'__BebasNeue_test', '__BebasNeue_Fallback_test'",
  "--font-caption-roboto": "'__Roboto_test', '__Roboto_Fallback_test'",
  "--font-caption-oswald": "'__Oswald_test', '__Oswald_Fallback_test'",
  "--font-caption-open-sans": "'__OpenSans_test', '__OpenSans_Fallback_test'",
  "--font-caption-anton": "'__Anton_test', '__Anton_Fallback_test'",
};

/**
 * Installs a minimal fake `document`/`getComputedStyle` for the duration of
 * `run`, then always restores the previous globals — even mid-test throws —
 * so no other test file sharing this worker ever observes the mock.
 */
function withMockedDom<T>(
  resolvedVariables: Record<string, string>,
  run: (loadCalls: string[]) => T,
): T {
  const loadCalls: string[] = [];
  const globals = globalThis as unknown as {
    document?: unknown;
    getComputedStyle?: unknown;
  };
  const originalDocument = globals.document;
  const originalGetComputedStyle = globals.getComputedStyle;

  globals.document = {
    documentElement: {},
    fonts: {
      load: (fontSpec: string) => {
        loadCalls.push(fontSpec);
        return Promise.resolve([]);
      },
    },
  };
  globals.getComputedStyle = () => ({
    getPropertyValue: (name: string) => resolvedVariables[name] ?? "",
  });

  try {
    return run(loadCalls);
  } finally {
    globals.document = originalDocument;
    globals.getComputedStyle = originalGetComputedStyle;
  }
}

describe("warmCaptionFonts", () => {
  test("is a safe no-op under SSR (no `document` global)", () => {
    // This suite runs under plain `bun test` with no DOM shim, so `document`
    // is genuinely undefined here — this exercises the real SSR guard, not a
    // simulation of it. Must run before any test below installs a fake
    // `document`, or it would trivially pass via the idempotency flag instead
    // of the SSR check this is meant to cover.
    expect(typeof document).toBe("undefined");
    expect(() => warmCaptionFonts()).not.toThrow();
  });

  test("loads every registered weight for every family, then is idempotent on repeat calls", () => {
    withMockedDom(FAKE_RESOLVED_FAMILIES, (loadCalls) => {
      expect(() => warmCaptionFonts()).not.toThrow();

      // 2 weights x 4 families (Montserrat, Roboto, Oswald, Open Sans)
      // + 1 weight x 2 single-weight display faces (Bebas Neue, Anton) = 10.
      expect(loadCalls).toHaveLength(10);
      expect(loadCalls).toContain("700 16px '__Montserrat_test', '__Montserrat_Fallback_test'");
      expect(loadCalls).toContain("400 16px '__Montserrat_test', '__Montserrat_Fallback_test'");
      expect(loadCalls).toContain("400 16px '__BebasNeue_test', '__BebasNeue_Fallback_test'");
      expect(loadCalls).toContain("400 16px '__Anton_test', '__Anton_Fallback_test'");
      // Bebas Neue and Anton are 400-only in layout.tsx — never request 700.
      expect(loadCalls).not.toContain("700 16px '__BebasNeue_test', '__BebasNeue_Fallback_test'");
      expect(loadCalls).not.toContain("700 16px '__Anton_test', '__Anton_Fallback_test'");

      // Second call within the same module lifetime must not repeat the work.
      warmCaptionFonts();
      expect(loadCalls).toHaveLength(10);
    });
  });
});
