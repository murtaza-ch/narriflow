import { describe, expect, test } from "bun:test";

import { resolveEffectiveLogoSettings } from "./logo-overlay";

const snapshot = { position: "bot-right", opacity: 80, scalePct: 15 } as const;

describe("resolveEffectiveLogoSettings", () => {
  test("no overrides (undefined/null) inherits the snapshot fully and stays enabled", () => {
    expect(resolveEffectiveLogoSettings(snapshot, undefined)).toEqual({
      enabled: true,
      position: "bot-right",
      opacity: 80,
      scalePct: 15,
    });
    expect(resolveEffectiveLogoSettings(snapshot, null)).toEqual({
      enabled: true,
      position: "bot-right",
      opacity: 80,
      scalePct: 15,
    });
  });

  test("all-null override fields (the schema default) inherit the snapshot", () => {
    expect(
      resolveEffectiveLogoSettings(snapshot, {
        enabled: true,
        position: null,
        opacity: null,
        scalePct: null,
      }),
    ).toEqual({ enabled: true, position: "bot-right", opacity: 80, scalePct: 15 });
  });

  test("non-null override fields win over the snapshot", () => {
    expect(
      resolveEffectiveLogoSettings(snapshot, {
        enabled: true,
        position: "top-left",
        opacity: 50,
        scalePct: 25,
      }),
    ).toEqual({ enabled: true, position: "top-left", opacity: 50, scalePct: 25 });
  });

  test("enabled: false wins regardless of other override/snapshot values", () => {
    expect(
      resolveEffectiveLogoSettings(snapshot, {
        enabled: false,
        position: "top-left",
        opacity: 50,
        scalePct: 25,
      }),
    ).toEqual({ enabled: false, position: "top-left", opacity: 50, scalePct: 25 });
  });

  test("partial override (only position set) inherits opacity/scalePct from the snapshot", () => {
    expect(
      resolveEffectiveLogoSettings(snapshot, {
        enabled: true,
        position: "mid-left",
        opacity: null,
        scalePct: null,
      }),
    ).toEqual({ enabled: true, position: "mid-left", opacity: 80, scalePct: 15 });
  });
});
