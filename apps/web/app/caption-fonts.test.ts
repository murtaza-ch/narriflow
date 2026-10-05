import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CAPTION_FONT_FACES } from "@narriflow/validators";

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
