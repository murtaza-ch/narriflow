import { expect, test } from "bun:test";
import documents from "../../../apps/media/src/__fixtures__/render-golden/documents.json";
import { resolveClipRenderTiming } from "@narriflow/validators";
import { clipPreparationTiming, clipPreparationPreviewWindow } from "./clip-preparation-policy";
import type { ClipPreparationInput } from "@narriflow/validators/clip-preparation";

test("caption-only observations and proxy retain the exact whole-source render window beyond the clip compiler maximum", () => {
  const input = { llmModel: "caption-only", document: { ...documents.cases["solo-auto-vertical"].document, clipStartSec: 0, clipEndSec: 600 },
    sourceProbe: { durationSec: 600, video: null, audio: null, facts: { format: { name: "fixture", startTimeSec: 0, durationSec: 600, sizeBytes: 100, bitRate: null }, attachedPictureCount: 0, videos: [], audios: [] } } } satisfies Pick<ClipPreparationInput, "llmModel" | "document" | "sourceProbe">;
  expect(clipPreparationTiming(input)).toEqual(resolveClipRenderTiming({ llmModel: input.llmModel, startSec: 0, endSec: 600, utterances: input.document.transcriptSlice }));
  expect(clipPreparationTiming(input).durationSec).toBe(600);
  expect(clipPreparationPreviewWindow(input)).toEqual({ startSec: 0, endSec: 600, durationSec: 600 });
  const detected = { ...input, llmModel: "fixture" };
  expect(clipPreparationTiming(detected)).toEqual(resolveClipRenderTiming({ llmModel: detected.llmModel, startSec: 0, endSec: 600, utterances: detected.document.transcriptSlice }));
});
