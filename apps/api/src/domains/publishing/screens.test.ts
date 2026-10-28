import { describe, expect, test } from "bun:test";
import { paddedCalendarWindow, performanceEmptyNextStep } from "./screens";

const owner = { role: "owner", status: "active" } as const;
const editor = { role: "editor", status: "active" } as const;
const viewer = { role: "viewer", status: "active" } as const;
const youtube = { platform: "youtube_shorts", publishingEligible: true } as const;

describe("paddedCalendarWindow", () => {
  test("widens both edges by 36 hours", () => {
    const window = paddedCalendarWindow({ from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-11T23:59:59Z") });
    expect(window.from.toISOString()).toBe("2026-10-03T12:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-10-13T11:59:59.000Z");
  });
});

describe("performanceEmptyNextStep", () => {
  test("a person who cannot publish is offered nothing", () => {
    expect(performanceEmptyNextStep(viewer, [youtube])).toBeNull();
  });

  test("a measurable connected account means publish", () => {
    expect(performanceEmptyNextStep(editor, [youtube])).toBe("publish");
  });

  test("accounts that cannot be measured or cannot publish do not count", () => {
    const unmeasurable = { platform: "linkedin", publishingEligible: true } as const;
    const ineligible = { platform: "tiktok", publishingEligible: false } as const;
    expect(performanceEmptyNextStep(owner, [unmeasurable, ineligible])).toBe("connect");
  });

  test("an editor without social.manage is told to ask", () => {
    expect(performanceEmptyNextStep(editor, [])).toBe("ask");
  });
});
