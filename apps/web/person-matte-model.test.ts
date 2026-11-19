import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MEDIAPIPE_TASKS_VISION_VERSION } from "./app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/person-matte-geometry";

// Heroes behind the speaker (dynamic captions spec 5.12): the Studio segments preview frames with
// the same model file the render image downloads and pins in apps/media/runtime-lock.json.
test("the Studio's person matte model is byte-identical to the render's pinned model", () => {
  const lock = JSON.parse(readFileSync(resolve(import.meta.dir, "../media/runtime-lock.json"), "utf8")) as {
    platforms: Record<string, { personMatteModel: { sha256: string; bytes: number } }>;
  };
  const pinned = lock.platforms["linux-x64"]!.personMatteModel;
  const bytes = readFileSync(resolve(import.meta.dir, "public/models/selfie_segmenter.tflite"));
  expect(bytes.byteLength).toBe(pinned.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(pinned.sha256);
});

test("the segmenter's WASM is fetched at the exact tasks-vision version the app installs", () => {
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  expect(manifest.dependencies["@mediapipe/tasks-vision"]).toBe(MEDIAPIPE_TASKS_VISION_VERSION);
});
