import { describe, expect, test } from "bun:test";
import { captionsPanelTab, panelSectionAttribute, PANEL_SCROLL_ATTRIBUTE, PANEL_STICKY_ATTRIBUTE, resolveToolOpening, revealPanelSection } from "./tool-target";

describe("opening a tool at a place", () => {
  test("a bare tool opens at its top; a target carries the place", () => {
    expect(resolveToolOpening("censor")).toEqual({ tool: "censor", target: null });
    const target = { tool: "captions", section: "emojis" } as const;
    expect(resolveToolOpening(target)).toEqual({ tool: "captions", target });
  });

  test("Captions opens on Customize for either section, on Presets otherwise", () => {
    expect(captionsPanelTab({ tool: "captions", section: "emojis" })).toBe("customize");
    expect(captionsPanelTab({ tool: "captions", section: "emphasis" })).toBe("customize");
    expect(captionsPanelTab(null)).toBe("presets");
  });

  test("marks a section for the reveal", () => {
    expect(panelSectionAttribute("emphasis")).toEqual({ "data-panel-section": "emphasis" });
  });
});

/** Just the box geometry `revealPanelSection` reads. */
function fakePanel(input: { sectionTop: number; containerTop: number; scrollTop: number; stickyHeight: number | null; hasSection?: boolean }) {
  const scrolls: number[] = [];
  const container = {
    scrollTop: input.scrollTop,
    getBoundingClientRect: () => ({ top: input.containerTop }),
    scrollTo: ({ top }: { top: number }) => scrolls.push(top),
  };
  const section = {
    getBoundingClientRect: () => ({ top: input.sectionTop }),
    closest: (selector: string) => (selector === `[${PANEL_SCROLL_ATTRIBUTE}]` ? container : null),
  };
  const sticky = input.stickyHeight === null ? null : { offsetHeight: input.stickyHeight };
  const root = {
    querySelector: (selector: string) => {
      if (selector === '[data-panel-section="emojis"]') return input.hasSection === false ? null : section;
      if (selector === `[${PANEL_STICKY_ATTRIBUTE}]`) return sticky;
      return null;
    },
  };
  return { root: root as unknown as HTMLElement, scrolls };
}

describe("revealing a section", () => {
  test("scrolls the panel body so the section lands just below the sticky preview", () => {
    const { root, scrolls } = fakePanel({ sectionTop: 900, containerTop: 100, scrollTop: 40, stickyHeight: 180 });
    revealPanelSection(root, "emojis");
    // 900 - 100 + 40 - 180 - 8
    expect(scrolls).toEqual([652]);
  });

  test("without a sticky header, and never above the top", () => {
    const below = fakePanel({ sectionTop: 300, containerTop: 100, scrollTop: 0, stickyHeight: null });
    revealPanelSection(below.root, "emojis");
    expect(below.scrolls).toEqual([192]);
    const near = fakePanel({ sectionTop: 104, containerTop: 100, scrollTop: 0, stickyHeight: 60 });
    revealPanelSection(near.root, "emojis");
    expect(near.scrolls).toEqual([0]);
  });

  test("a section the style does not show is a no-op", () => {
    const { root, scrolls } = fakePanel({ sectionTop: 0, containerTop: 0, scrollTop: 0, stickyHeight: null, hasSection: false });
    revealPanelSection(root, "emojis");
    revealPanelSection(null, "emojis");
    expect(scrolls).toEqual([]);
  });
});
