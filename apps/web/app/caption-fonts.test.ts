import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CAPTION_FONT_FACES, CAPTION_PICKER_FONT_NAMES } from "@narriflow/validators";

test("next/font loads every vendored face with the shared libass metrics", () => {
  const source = readFileSync(new URL("./caption-fonts.ts", import.meta.url), "utf8");
  const definitions = [...source.matchAll(/localFont\(\{([\s\S]*?)\}\)/g)].map((match) => match[1]!);
  expect(definitions).toHaveLength(CAPTION_FONT_FACES.length);
  for (const face of CAPTION_FONT_FACES) {
    const definition = definitions.find((block) => block.includes(`/fonts/${face.file}"`));
    expect(definition).toBeDefined();
    expect(definition).toContain(`weight: "${face.weight}"`);
    expect(definition).toContain(`style: "${face.style}"`);
    for (const [property, metric] of [["ascent-override", face.ascent], ["descent-override", face.descent]] as const) {
      const value = Number(definition!.match(new RegExp(`prop: "${property}", value: "([\\d.]+)%"`))?.[1]);
      expect(value).toBeCloseTo(metric * 100, 6);
    }
    expect(definition).toContain('prop: "line-gap-override", value: "0%"');
    expect(definition).toContain("preload: false");
  }
});

test("the classic font chips and the brand kit list leave out the template-only faces", () => {
  const panel = readFileSync(new URL("./(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/captions-panel.tsx", import.meta.url), "utf8");
  const brandKit = readFileSync(new URL("./(app)/brand-kit/_components/template-form.tsx", import.meta.url), "utf8");
  for (const source of [panel, brandKit]) {
    expect(source).toContain("CAPTION_PICKER_FONT_NAMES");
    expect(source).not.toMatch(/CAPTION_FONT_NAMES(?!\w)/);
  }
  expect(CAPTION_PICKER_FONT_NAMES.length).toBe(CAPTION_FONT_FACES.filter((face) => !("templateOnly" in face)).length);
  for (const name of ["Caveat Brush", "Permanent Marker", "Inter Tight Bold", "JetBrains Mono Medium", "Unbounded Black"]) {
    expect(CAPTION_PICKER_FONT_NAMES as readonly string[]).not.toContain(name);
  }
});
