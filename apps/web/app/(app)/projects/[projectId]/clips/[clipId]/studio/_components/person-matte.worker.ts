// Person matte for heroes behind the speaker in the Studio preview (dynamic captions spec 5.12).
// A module Web Worker running MediaPipe's ImageSegmenter on the CPU with the same Selfie Segmenter
// model the render uses (/models/selfie_segmenter.tflite). Bundlers may emit this worker as a
// classic script (Turbopack in development) or a module: the classic WASM loader is tried first,
// then the module loader, which a module worker needs (there `importScripts` throws and
// tasks-vision imports the loader as a module).

import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import { MEDIAPIPE_WASM_BASE } from "./person-matte-geometry";

interface InitMessage {
  readonly type: "init";
  readonly modelUrl: string;
}

interface FrameMessage {
  readonly type: "frame";
  readonly id: number;
  readonly bitmap: ImageBitmap;
}

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<InitMessage | FrameMessage>) => void) | null;
};


let segmenter: ImageSegmenter | null = null;

scope.onmessage = async (event) => {
  const message = event.data;
  if (message.type === "init") {
    const create = async (module: boolean) =>
      ImageSegmenter.createFromOptions(await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE, module), {
        baseOptions: { modelAssetPath: message.modelUrl, delegate: "CPU" },
        runningMode: "IMAGE",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    try {
      segmenter = await create(false).catch(() => create(true));
      scope.postMessage({ type: "ready" });
    } catch (error) {
      scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const { bitmap, id } = message;
  try {
    if (!segmenter) throw new Error("segmenter not ready");
    const result = segmenter.segment(bitmap);
    const mask = result.confidenceMasks?.[0];
    if (!mask) throw new Error("no mask");
    const confidence = mask.getAsFloat32Array();
    const data = new Uint8ClampedArray(confidence.length);
    for (let index = 0; index < confidence.length; index++) data[index] = confidence[index]! * 255 + 0.5;
    const { width, height } = mask;
    result.close();
    scope.postMessage({ type: "mask", id, width, height, data }, [data.buffer]);
  } catch (error) {
    scope.postMessage({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
  } finally {
    bitmap.close();
  }
};
