/** Reads `source/catalog.json` into the designs the compiler builds (skin-tone variants excluded). */
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface CatalogRow {
  name: string;
  file: string;
  fallback: string;
  group: string;
  design?: string;
  skinTone?: string;
  caption?: string;
  keywords?: string;
}

export interface CatalogDesign {
  id: string;
  name: string;
  file: string;
  glyph: string;
  group: string;
  kind: "single" | "phrase";
  hasTones: boolean;
  keywords: string[];
}

export interface Catalog {
  designs: CatalogDesign[];
  groups: { id: string; name: string }[];
  /** Skin-tone variant files by base id, tones 1 to 5. */
  variants: Map<string, { tone: number; file: string }[]>;
}

const TONES = ["light", "medium-light", "medium", "medium-dark", "dark"];
const STOPWORDS = new Set(
  "a an and are as at be but by for from has have i im in is it its me my of on or our so that the this to was we with you your".split(" "),
);

export function slug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function words(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

export function readCatalog(sourceDir: string): Catalog {
  const rows = JSON.parse(readFileSync(join(sourceDir, "catalog.json"), "utf8")) as CatalogRow[];
  const bases = rows.filter((row) => row.design === undefined);
  const idByName = new Map<string, string>();
  const groups: { id: string; name: string }[] = [];
  const designs: CatalogDesign[] = [];
  const toned = new Set(rows.filter((row) => row.design !== undefined).map((row) => row.design!));
  for (const row of bases) {
    const id = slug(row.name);
    if (!id || idByName.has(row.name) || designs.some((d) => d.id === id)) throw new Error(`duplicate or empty id for ${row.name}`);
    idByName.set(row.name, id);
    const group = row.file.split("/")[0]!;
    if (!groups.some((g) => g.id === group)) groups.push({ id: group, name: row.group });
    designs.push({
      id,
      name: row.name,
      file: row.file,
      glyph: row.fallback,
      group,
      kind: group === "phrases" ? "phrase" : "single",
      hasTones: toned.has(row.name),
      keywords: [...new Set([...words(row.name), ...words(row.keywords), ...words(row.caption)])],
    });
  }
  const variants = new Map<string, { tone: number; file: string }[]>();
  for (const row of rows) {
    if (row.design === undefined) continue;
    const id = idByName.get(row.design);
    const tone = TONES.indexOf(row.skinTone ?? "") + 1;
    if (!id || tone === 0) throw new Error(`variant ${row.file} has no base or tone`);
    variants.set(id, [...(variants.get(id) ?? []), { tone, file: row.file }]);
  }
  return { designs, groups, variants };
}
