import { describe, expect, test } from "bun:test";
import { CAPTION_SCENES, CAPTION_SCENE_NAMES } from "./caption-scene";

describe("Scene Style metadata", () => {
  test("every Scene Style draws a hero, Dialogue included (the plan's comment says so)", () => {
    for (const name of CAPTION_SCENE_NAMES) expect(CAPTION_SCENES[name].emphasis).toBe("auto");
  });
});
