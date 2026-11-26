import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptionPresetId, NamedCaptionPreset } from "@narriflow/validators";
import { captionPresetBackdropSrc } from "../../app/(app)/_shared/caption-preset-backdrops";
import { PRESET_CARD_FRAME } from "../../app/(app)/_shared/caption-card-frame";

/**
 * Bump when a change outside a preset's own definition and Scene Style file alters how cards draw (a painter, a shared
 * layout helper, the frame), then re-render every clip: `bun run --cwd apps/web cards:render -- --all`.
 */
export const CARD_RENDER_VERSION = 1;

/** Frames per second and CSS width the clips are recorded at (device pixels are twice the width). */
export const CARD_FPS = 60;
export const CARD_WIDTH = 200;

const REPO = join(import.meta.dir, "../../../..");

/**
 * What a card clip is rendered from, hashed: the preset's look, its backdrop, its Scene Style program (the file that
 * holds the template and its sample script) and the recording settings. The manifest stores it beside each clip, and a
 * test fails when a preset's current hash differs from its clip's.
 */
export function captionCardSourceHash(named: NamedCaptionPreset): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ version: CARD_RENDER_VERSION, fps: CARD_FPS, width: CARD_WIDTH, frame: PRESET_CARD_FRAME, preset: named.preset }));
  hash.update(captionPresetBackdropSrc(named.id as Exclude<CaptionPresetId, "brand_default">));
  if (named.preset.scene) hash.update(readFileSync(join(REPO, "packages/caption-scene/src/templates", `${named.preset.scene}.ts`)));
  return hash.digest("hex");
}
