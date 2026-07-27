import { describe, expect, test } from "bun:test";
import { system } from "./theme";

/**
 * NOTE ON EXECUTION: packages/ui's `test` script is currently a deliberate
 * no-op (`echo 'ui test: no-op'`), so this file isn't part of `bun run test`
 * yet — but it runs correctly today via a direct `bun test` in this package,
 * and starts contributing the moment that script is wired up. Written now
 * because the studio.danger contrast guarantee below is exactly the kind of
 * thing that should fail loudly if it ever regresses.
 */

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
// Every studio.* semantic token must resolve to exactly one value (Blueline:
// "studio editor chrome is permanently graphite, mode-invariant") — unlike
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
  test("is exactly the rgba(14, 16, 19, 0.72) literal previously duplicated per-file", () => {
    expect(resolvedColor("studio.scrim")).toBe("rgba(14, 16, 19, 0.72)");
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
