import { describe, expect, test } from "bun:test";
import { system } from "./theme";

function resolvedColor(name: string): string {
  const token = system.tokens.getByName(`colors.${name}`);
  if (!token) throw new Error(`Missing semantic token: colors.${name}`);
  return String(token.value);
}

// ─── WCAG 2.1 contrast ──────────────────────────────────────────────────────

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─── studio.* mode-invariance ───────────────────────────────────────────────
//
// Every studio.* semantic token must resolve to one value, unlike
// bg.*/fg.*/danger.* etc., which are intentionally { _light, _dark } pairs.

describe("studio.* tokens stay mode-invariant", () => {
  test("the new danger/scrim tokens carry a single unconditional value", () => {
    for (const name of ["studio.danger", "studio.dangerBorder", "studio.scrim"]) {
      const token = system.tokens.getByName(`colors.${name}`);
      expect(token).toBeDefined();
      expect(token!.extensions.conditions).toEqual({ base: token!.value });
    }
  });
});

// ─── studio.scrim ────────────────────────────────────────────────────────────

describe("studio.scrim", () => {
  test("is exactly the rgba(16, 16, 16, 0.72) literal previously duplicated per-file", () => {
    expect(resolvedColor("studio.scrim")).toBe("rgba(16, 16, 16, 0.72)");
  });

  test("its rgb triplet matches studio.canvas at 0.72 alpha (the comment's claim, checked)", () => {
    const canvas = resolvedColor("studio.canvas"); // "#0E1013"
    const r = Number.parseInt(canvas.slice(1, 3), 16);
    const g = Number.parseInt(canvas.slice(3, 5), 16);
    const b = Number.parseInt(canvas.slice(5, 7), 16);
    expect(resolvedColor("studio.scrim")).toBe(`rgba(${r}, ${g}, ${b}, 0.72)`);
  });
});

// ─── studio.danger / studio.dangerBorder ────────────────────────────────────
//
// The defect: video-preview.tsx's error state used danger.solid/danger.fg —
// both mode-dependent — on the mode-invariant studio.subtle surface. In light
// mode danger.fg is danger.600 (#C42B1C), ~3.2:1 on studio.subtle (#14171C),
// below the 4.5:1 AA floor for text. studio.danger fixes this by being a
// single graphite-tuned value regardless of app theme.

describe("studio.danger contrast (WCAG AA)", () => {
  test("clears 4.5:1 (AA, normal text) against studio.subtle and studio.surface", () => {
    const danger = resolvedColor("studio.danger");
    const subtleRatio = contrastRatio(danger, resolvedColor("studio.subtle"));
    const surfaceRatio = contrastRatio(danger, resolvedColor("studio.surface"));

    expect(subtleRatio).toBeGreaterThanOrEqual(4.5);
    expect(surfaceRatio).toBeGreaterThanOrEqual(4.5);
  });

  test("also clears 4.5:1 against studio.canvas and studio.raised, for robustness", () => {
    const danger = resolvedColor("studio.danger");
    expect(contrastRatio(danger, resolvedColor("studio.canvas"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(danger, resolvedColor("studio.raised"))).toBeGreaterThanOrEqual(4.5);
  });

  test("is meaningfully lighter than the old light-mode danger.fg it replaces (regression guard)", () => {
    // Pins the exact bug: danger.600 on studio.subtle was ~3.2:1, failing AA.
    const oldLightModeFg = resolvedColor("danger.600"); // "#C42B1C"
    const oldRatio = contrastRatio(oldLightModeFg, resolvedColor("studio.subtle"));
    expect(oldRatio).toBeLessThan(4.5);

    const newRatio = contrastRatio(resolvedColor("studio.danger"), resolvedColor("studio.subtle"));
    expect(newRatio).toBeGreaterThan(oldRatio);
  });
});

describe("studio.dangerBorder contrast (WCAG 1.4.11, non-text)", () => {
  test("clears 3:1 against every studio surface tier", () => {
    const dangerBorder = resolvedColor("studio.dangerBorder");
    for (const surface of ["studio.canvas", "studio.subtle", "studio.surface", "studio.raised"]) {
      expect(contrastRatio(dangerBorder, resolvedColor(surface))).toBeGreaterThanOrEqual(3);
    }
  });
});


describe("dashboard text contrast", () => {
  for (const mode of ["_light", "_dark"] as const) {
    test(`${mode}: body and secondary text remain readable on every surface`, () => {
      const color = (name: string) => {
        const token = system.tokens.getByName(`colors.${name}`)!;
        const conditions = token.extensions.conditions as Record<string, string>;
        const value = conditions[mode] ?? String(token.value);
        const reference = value.match(/^\{colors\.(.+)\}$/);
        return reference ? resolvedColor(reference[1]!) : value;
      };
      for (const surface of ["bg", "bg.panel", "bg.dialog", "bg.raised", "bg.sidebar"]) {
        for (const foreground of ["fg", "fg.muted", "fg.subtle"]) {
          expect(contrastRatio(color(foreground), color(surface))).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const palette of ["brand", "accent"]) {
        expect(contrastRatio(color(`${palette}.solid`), color(`${palette}.contrast`))).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

// Check the resolved recipes, including Chakra's inherited size/text styles.
// A matching height alone previously hid a larger Select font in toolbars.
describe("single-line control consistency", () => {
  test("standard buttons, fields, and filters resolve to the same dimensions", () => {
    const styles = [
      system.cva(system.getRecipe("button"))({ size: "sm" }),
      system.cva(system.getRecipe("input"))({ size: "sm" }),
      system.sva(system.getSlotRecipe("select"))({ size: "sm" }).trigger,
      system.sva(system.getSlotRecipe("nativeSelect"))({ size: "sm" }).field,
      system.sva(system.getSlotRecipe("datePicker"))({ size: "sm" }).input,
      system.sva(system.getSlotRecipe("numberInput"))({ size: "sm" }).input,
    ];
    for (const style of styles) {
      const resolved = style?.["@layer recipes"] as Record<string, unknown>;
      expect(resolved.height).toBe("var(--chakra-sizes-9)");
      expect(resolved.fontSize).toBe("13px");
      expect(resolved.borderRadius).toBe("var(--chakra-radii-l2)");
    }
    const segmented = system.sva(system.getSlotRecipe("segmentGroup"))({ size: "sm" });
    expect((segmented.root?.["@layer recipes"] as Record<string, unknown>).height).toBe("var(--chakra-sizes-9)");
    expect((segmented.item?.["@layer recipes"] as Record<string, unknown>).fontSize).toBe("13px");
  });
});
