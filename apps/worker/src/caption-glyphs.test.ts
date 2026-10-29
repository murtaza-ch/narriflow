import { describe, expect, test } from "bun:test";
import { CAPTION_FONT_FACES } from "@narriflow/validators";
import {
  CAPTION_RENDER_DIAGNOSTIC_PATTERN,
  CaptionGlyphPlanner,
  captionRenderDiagnosticsFailure,
  catalogCaptionFace,
  classifyCaptionRenderDiagnostics,
  type OmittedGlyph,
  type CaptionGlyphNotice,
} from "./caption-glyphs";

function planner(name = "Montserrat") {
  const face = CAPTION_FONT_FACES.find((candidate) => candidate.name === name)!;
  const report = { notices: new Map<string, CaptionGlyphNotice>(), omitted: new Map<string, OmittedGlyph>() };
  return { planner: new CaptionGlyphPlanner(catalogCaptionFace(face, "requested"), null, report, 3), report };
}
const facesOf = (text: string) => planner().planner.plan(text).flatMap((cluster) => cluster.parts.map((part) => [part.text, part.face.assName]));

describe("caption glyph planner", () => {
  test("text the requested face covers never leaves it", () => {
    expect(facesOf("Hello, world 42!")).toEqual([...("Hello, world 42!")].map((character) => [character, "Montserrat Black"]));
  });

  test("scripts take their pinned Noto face, and neutral characters stay inside the run", () => {
    const runs = facesOf("مرحبا بكم").map(([, face]) => face);
    expect(new Set(runs)).toEqual(new Set(["Noto Sans Arabic Regular"]));
    expect(facesOf("Hi 你好")).toContainEqual(["你", "Noto Sans SC"]);
    expect(facesOf("안녕")).toContainEqual(["안", "Noto Sans KR"]);
    expect(facesOf("สวัสดี")[0]![1]).toBe("Noto Sans Thai Regular");
  });

  test("emoji clusters go to the monochrome face as one cluster and are reported", () => {
    const { planner: chain, report } = planner();
    const [family] = chain.plan("👨‍👩‍👧");
    expect(family!.parts).toHaveLength(1);
    expect(family!.parts[0]!.face.assName).toBe("Noto Emoji Regular");
    expect([...report.notices.values()]).toEqual([expect.objectContaining({ code: "glyph_fallback_used", font: "Noto Emoji Regular", sequenceSplit: true })]);
  });

  test("a code point outside every pinned face is left out, and only that code point", () => {
    const { planner: chain, report } = planner();
    const clusters = chain.plan("a\u{13000}b");
    expect(clusters.map((cluster) => cluster.parts.map((part) => part.text).join(""))).toEqual(["a", "", "b"]);
    expect([...report.omitted.values()]).toEqual([{ codePoint: "U+13000", cueIndex: 3 }]);
  });

  test("forced omissions drop a code point that libass reported, keeping the rest of its cluster", () => {
    const report = { notices: new Map<string, CaptionGlyphNotice>(), omitted: new Map<string, OmittedGlyph>() };
    const face = CAPTION_FONT_FACES.find((candidate) => candidate.name === "Montserrat")!;
    const chain = new CaptionGlyphPlanner(catalogCaptionFace(face, "requested"), null, report, 0, new Set([0x645]));
    expect(chain.plan("مرحبا").map((cluster) => cluster.parts.map((part) => part.text).join("")).join("")).toBe("رحبا");
    expect([...report.omitted.values()]).toEqual([{ codePoint: "U+645", cueIndex: 0 }]);
  });
});

describe("render diagnostics on a zero exit", () => {
  const missing = "[Parsed_ass_4 @ 0x1] fontselect: failed to find any fallback with glyph 0x13000 for font: (Montserrat Black, 400, 0)";
  const host = "[Parsed_ass_4 @ 0x1] Glyph 0x645 not found, selecting one more font for (Montserrat Black, 400, 0)";
  const drawtext = "[Parsed_drawtext_3 @ 0x1] Failed to parse text: invalid expansion";

  test("the stream filter keeps only libass and drawtext font lines", () => {
    for (const line of [missing, host, drawtext]) expect(CAPTION_RENDER_DIAGNOSTIC_PATTERN.test(line)).toBe(true);
    expect(CAPTION_RENDER_DIAGNOSTIC_PATTERN.test("frame=  12 fps=0.0 q=-1.0")).toBe(false);
  });

  test("a missing glyph is a permanent typed failure; a host fallback is surfaced, not fatal", () => {
    const diagnostics = classifyCaptionRenderDiagnostics([missing, host, drawtext]);
    expect(diagnostics.missingGlyphs).toEqual([missing]);
    expect(diagnostics.hostFallbacks).toEqual([host]);
    expect(diagnostics.parseErrors).toEqual([drawtext]);
    const failure = captionRenderDiagnosticsFailure(diagnostics);
    expect(failure?.code).toBe("caption_glyph_unavailable");
    expect(failure?.disposition).toBe("permanent");
    expect(failure?.glyphs[0]?.codePoints).toEqual(["U+13000"]);
    expect(captionRenderDiagnosticsFailure(classifyCaptionRenderDiagnostics([host, drawtext]))).toBeNull();
  });
});
