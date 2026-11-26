import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CAPTION_PRESETS } from "@narriflow/validators";
import { captionCardSourceHash } from "../../../scripts/caption-cards/source-hash";
import { CAPTION_CARD_CLIPS, presetHasCardClip } from "./caption-card-clips";

const PUBLIC = join(import.meta.dir, "../../../public/caption-cards");
const RENDER = "bun run --cwd apps/web cards:render (with the web dev server running)";

describe("caption card clips", () => {
  const carded = CAPTION_PRESETS.filter((named) => presetHasCardClip(named.preset));

  test("every Dynamic and Scene Style preset has a recorded clip and poster", () => {
    const missing = carded.filter((named) => !CAPTION_CARD_CLIPS[named.id] || !existsSync(join(PUBLIC, `${named.id}.mp4`)) || !existsSync(join(PUBLIC, `${named.id}.webp`)));
    expect(missing.map((named) => named.id), `record them: ${RENDER}`).toEqual([]);
  });

  test("every clip was recorded from the preset and Scene Style as they are now", () => {
    const stale = carded.filter((named) => CAPTION_CARD_CLIPS[named.id] && CAPTION_CARD_CLIPS[named.id]!.hash !== captionCardSourceHash(named));
    expect(stale.map((named) => named.id), `re-record them: ${RENDER}`).toEqual([]);
  });

  test("the manifest lists no preset that is not carded", () => {
    const ids = new Set(carded.map((named) => named.id));
    expect(Object.keys(CAPTION_CARD_CLIPS).filter((id) => !ids.has(id))).toEqual([]);
  });
});
