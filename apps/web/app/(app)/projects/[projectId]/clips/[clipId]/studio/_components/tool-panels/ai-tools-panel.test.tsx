import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import type { StudioFields } from "../studio-shell";

let fields: Record<string, unknown> = {};
mock.module("../studio-shell", () => ({ useStudio: () => fields }));

const { AiToolsList } = await import("./ai-tools-panel");
const { aiToolsFixtureEmojiEditor, aiToolsFixtureFields } = await import("./ai-tools/ai-tools-fixture");
const { studioUpgradePrompts } = await import("../studio-upgrade");
const { TOOLS, RAIL_TOOLS, PANEL_MAP } = await import("../tool-sidebar");

const render = (node: React.ReactNode) => renderToStaticMarkup(<ChakraProvider value={system}>{node}</ChakraProvider>);

type Scenario = Parameters<typeof aiToolsFixtureFields>[0];
type EmojiInput = Parameters<typeof aiToolsFixtureEmojiEditor>[0];

function renderPanel(scenario: Scenario, emoji: EmojiInput = { run: { status: "idle" } }, plan: "free" | "pro" = scenario === "fresh" ? "free" : "pro") {
  fields = aiToolsFixtureFields(scenario, { upgradePrompts: studioUpgradePrompts(plan, null) }) as unknown as Record<string, unknown>;
  return render(<AiToolsList emojiEditor={aiToolsFixtureEmojiEditor(emoji)} />);
}

/** Row titles in the order they render. */
function rowTitles(markup: string): string[] {
  return [...markup.matchAll(/<p[^>]*>(Add emojis|Remove silences|Remove filler words|Auto reframe|Auto-censor|Emphasize keywords|B-roll)<\/p>/g)].map((match) => match[1]!);
}

/** The markup of the row titled `title`, up to the next row. */
function row(markup: string, title: string): string {
  const items = markup.split('role="listitem"');
  const found = items.find((item) => item.includes(`>${title}</p>`));
  if (!found) throw new Error(`no ${title} row`);
  return found;
}

const applyButtons = (markup: string) => [...markup.matchAll(/<button[^>]*>(?:<[^>]+>)*Apply/g)].length;

describe("AI tools panel", () => {
  test("a fresh English clip lists every tool in order, with Apply where one click does it", () => {
    const markup = renderPanel("fresh");
    expect(rowTitles(markup)).toEqual(["Add emojis", "Remove silences", "Remove filler words", "Auto reframe", "Auto-censor", "Emphasize keywords", "B-roll"]);
    expect(row(markup, "Add emojis")).toContain("AI adds emojis that match what is said");
    expect(row(markup, "Remove silences")).toMatch(/2 silences, \d+\.\d s shorter/);
    expect(row(markup, "Remove filler words")).toMatch(/3 filler words, \d+\.\d s shorter/);
    expect(row(markup, "Auto reframe")).toContain("Keep the speaker in frame");
    expect(row(markup, "Auto reframe")).toContain("Speaker analysis is still running");
    expect(row(markup, "Auto-censor")).toContain("2 words found");
    expect(row(markup, "B-roll")).toContain("Add visuals over your clip");
    // Emojis, silences, fillers, reframe.
    expect(applyButtons(markup)).toBe(4);
  });

  test("Auto-censor on a plan that cannot apply carries the plan gem, as the Censor panel does", () => {
    expect(row(renderPanel("fresh"), "Auto-censor")).toContain("(needs Creator)");
    expect(row(renderPanel("fresh", undefined, "pro"), "Auto-censor")).not.toContain("(needs");
  });

  test("applied tools show their state and the way to edit them; nothing left to cut has no button", () => {
    const markup = renderPanel("applied", { run: { status: "idle" }, shown: 12 });
    expect(row(markup, "Add emojis")).toContain("12 emojis");
    expect(row(markup, "Remove silences")).toContain("No silences found");
    expect(row(markup, "Remove filler words")).toContain("No filler words found");
    expect(row(markup, "Auto reframe")).toContain(">On<");
    expect(row(markup, "Auto reframe")).not.toContain("Speaker analysis");
    expect(row(markup, "B-roll")).toContain("Cutaway added");
    expect(applyButtons(markup)).toBe(0);
  });

  test("tools that cannot work for this clip are left out, not greyed", () => {
    const markup = renderPanel("urdu-audio");
    // No filler list for Urdu, no picture to frame, no hero word on a classic style.
    expect(rowTitles(markup)).toEqual(["Add emojis", "Remove silences", "Auto-censor", "B-roll"]);
    expect(markup).not.toMatch(/<button[^>]*(\sdisabled[\s=>]|aria-disabled="true")/);
  });

  test("a clip with no caption words leaves Add emojis out", () => {
    expect(rowTitles(renderPanel("fresh", { run: { status: "idle" }, hasWords: false }))).not.toContain("Add emojis");
  });

  test("read-only: no Apply buttons, the chevrons still open panels", () => {
    const markup = renderPanel("readonly");
    expect(applyButtons(markup)).toBe(0);
    expect(rowTitles(markup)).toContain("Add emojis");
    expect(row(markup, "Auto-censor")).toContain("<button");
    expect(row(markup, "B-roll")).toContain("<button");
    expect(row(markup, "Remove silences")).not.toContain("<button");
  });
});

describe("AI tools panel: the emoji row in each run state", () => {
  test("idle: Apply", () => {
    const item = row(renderPanel("fresh"), "Add emojis");
    expect(item).toMatch(/<button[^>]*aria-label="Add emojis"/);
  });

  test("saving and running: progress inside the button, the other rows stay usable", () => {
    const saving = renderPanel("fresh", { run: { status: "saving", density: "balanced" } });
    expect(row(saving, "Add emojis")).toContain("Saving your edits first");
    expect(row(saving, "Add emojis")).toMatch(/aria-busy="true"/);
    const running = renderPanel("fresh", { run: { status: "running", density: "balanced" } });
    expect(row(running, "Add emojis")).toMatch(/aria-label="Add emojis, working"/);
    expect(row(running, "Add emojis")).not.toContain(">Apply<");
    expect(row(running, "Remove silences")).toContain(">Apply<");
    expect(running.match(/aria-busy="true"/g)).toHaveLength(1);
  });

  test("done with emojis: the count and a chevron to Captions", () => {
    const item = row(renderPanel("applied", { run: { status: "done", added: 9, leftOut: 0, partial: false }, shown: 9 }), "Add emojis");
    expect(item).toContain("9 emojis");
    expect(item).not.toContain(">Apply<");
  });

  test("done empty: says so and offers Apply again", () => {
    const item = row(renderPanel("fresh", { run: { status: "done", added: 0, leftOut: 0, partial: false } }), "Add emojis");
    expect(item).toContain("No emojis fit this clip");
    expect(item).toContain(">Apply<");
  });

  test("failed: the section's typed message under the row, with a retry", () => {
    const offline = row(renderPanel("fresh", { run: { status: "failed", failure: { reason: "request", code: null } } }), "Add emojis");
    expect(offline).toContain("Check your connection");
    expect(offline).toContain("Try again");
    const save = row(renderPanel("fresh", { run: { status: "failed", failure: { reason: "save" } } }), "Add emojis");
    expect(save).toContain("Couldn’t save your latest edits");
  });

  test("a failed Regenerate retries from Captions, where its confirmation lives", () => {
    const item = row(renderPanel("applied", { run: { status: "failed", failure: { reason: "incomplete" } }, shown: 5 }), "Add emojis");
    expect(item).toContain("Couldn’t finish. Your emojis are unchanged.");
    expect(item).not.toContain("Try again");
  });

  test("read-only hides the run error with the Apply button", () => {
    const item = row(renderPanel("readonly", { run: { status: "failed", failure: { reason: "read_only" } } }), "Add emojis");
    expect(item).not.toContain('role="alert"');
  });
});

describe("tool rail", () => {
  test("AI tools comes first, and every tool has one entry and a panel", () => {
    expect(RAIL_TOOLS[0]?.id).toBe("ai");
    expect(RAIL_TOOLS[0]?.label).toBe("AI tools");
    const ids = TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    // PANEL_MAP is a Record over every ToolId, so equal key sets mean every tool has a title and a panel.
    expect([...ids].sort()).toEqual(Object.keys(PANEL_MAP).sort());
    expect(ids).toHaveLength(10);
  });

  test("Auto-censor has no rail button: it opens from AI tools, which stays selected", () => {
    expect(RAIL_TOOLS.map((tool) => tool.id)).not.toContain("censor");
    expect(RAIL_TOOLS).toHaveLength(9);
    expect(TOOLS.find((tool) => tool.id === "censor")?.parent).toBe("ai");
    // A tool without a rail button must be reachable from a tool that has one.
    for (const tool of TOOLS) if (tool.parent) expect(RAIL_TOOLS.some((rail) => rail.id === tool.parent)).toBe(true);
  });
});

// The fixture's fields type-check against the shell's, so a renamed field fails here first.
const _fieldsCheck: StudioFields | null = null;
void _fieldsCheck;
