/**
 * Rebuilds emoji/atlas.png and emoji/atlas.json from the pinned Noto Emoji
 * release: `bun packages/caption-fonts/scripts/build-emoji-atlas.ts`.
 *
 * The atlas holds the artwork for every emoji the caption pipeline can place
 * (the keyword table plus the literal sequences the tests pin). Studio and the
 * export overlays read the same sprite sheet through src/emoji.ts. Adding an
 * emoji means adding it to EXTRA_SEQUENCES and re-running this script; the
 * pinned tag and every source PNG hash are recorded so a rebuild is auditable.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTION_EMOJI_MAP } from "@narriflow/validators";

const TAG = "v2026-09-24-unicode18_0";
const COMMIT = "e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e";
const CELL = 128;
const COLUMNS = 8;
/** Literal clusters the tests keep intact: ZWJ family and a skin-tone modifier sequence. */
const EXTRA_SEQUENCES = ["👨‍👩‍👧", "👍🏽"];

const emojiDirectory = fileURLToPath(new URL("../emoji/", import.meta.url));

/** Noto file naming: lower-case hex code points joined by `_`, without U+FE0F. */
function notoKey(sequence: string): string {
  return [...sequence]
    .map((character) => character.codePointAt(0)!)
    .filter((codePoint) => codePoint !== 0xfe0f)
    .map((codePoint) => codePoint.toString(16))
    .join("_");
}

const keys = [...new Set([...Object.values(CAPTION_EMOJI_MAP), ...EXTRA_SEQUENCES].map(notoKey))].sort();
const rows = Math.ceil(keys.length / COLUMNS);
const work = await mkdtemp(join(tmpdir(), "narriflow-emoji-atlas-"));
try {
  const sequences: Record<string, { column: number; row: number; sha256: string }> = {};
  for (const [index, key] of keys.entries()) {
    const response = await fetch(`https://raw.githubusercontent.com/googlefonts/noto-emoji/${COMMIT}/2D/png/128/emoji_u${key}.png`);
    if (!response.ok) throw new Error(`Noto artwork ${key} is missing at ${TAG} (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(join(work, `${String(index).padStart(3, "0")}.png`), bytes);
    sequences[key] = { column: index % COLUMNS, row: Math.floor(index / COLUMNS), sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  // Pad the last row with transparent cells so the sheet is a full grid.
  const blank = Buffer.from(await new Response(Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", `color=c=black@0:s=${CELL}x${CELL},format=rgba`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], { stdout: "pipe" }).stdout).arrayBuffer());
  for (let index = keys.length; index < COLUMNS * rows; index++) await writeFile(join(work, `${String(index).padStart(3, "0")}.png`), blank);
  const sheet = join(work, "atlas.png");
  const tiled = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-framerate", "1", "-i", join(work, "%03d.png"), "-vf", `format=rgba,tile=${COLUMNS}x${rows}`, "-frames:v", "1", "-compression_level", "9", sheet]);
  if (tiled.exitCode !== 0) throw new Error(`ffmpeg tile failed: ${tiled.stderr.toString()}`);
  const sheetBytes = await readFile(sheet);
  await mkdir(emojiDirectory, { recursive: true });
  await writeFile(join(emojiDirectory, "atlas.png"), sheetBytes);
  await writeFile(
    join(emojiDirectory, "atlas.json"),
    `${JSON.stringify(
      {
        version: 1,
        source: { repository: "https://github.com/googlefonts/noto-emoji", tag: TAG, commit: COMMIT, path: "2D/png/128", license: "emoji/LICENSE.txt" },
        cell: { width: CELL, height: CELL },
        columns: COLUMNS,
        rows,
        sheet: { width: COLUMNS * CELL, height: rows * CELL, sha256: createHash("sha256").update(sheetBytes).digest("hex") },
        sequences,
      },
      null,
      2,
    )}\n`,
  );
  console.warn(JSON.stringify({ level: "info", message: "emoji atlas rebuilt", sequences: keys.length, sheetBytes: sheetBytes.length }));
} finally {
  await rm(work, { recursive: true, force: true });
}
