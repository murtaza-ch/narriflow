import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { WorkflowFailure } from "@narriflow/services";
import { createLayoutEvidenceDetectors } from "./layout-evidence-runtime";
import { parseRenderConfig } from "./render-config";
import { WorkerProcessFailure, productionWorkerProcessModule, type WorkerProcessModule } from "./worker-process";

const detection = { sourcePath: "clip.mp4", startSec: 0, durationSec: 10 };
function detectors(execute: WorkerProcessModule["execute"], signal = new AbortController().signal) {
  return createLayoutEvidenceDetectors({ config: parseRenderConfig({}), signal, workerProcess: {
    execute, inspectMedia: async () => { throw new Error("unused"); }, withScratchDirectory: async (_prefix, work) => work("unused"),
  } });
}

describe("layout detector process boundary", () => {
  test.each(["detectFacePath", "detectMultiFacePath", "detectPipPath", "detectSceneCuts"] as const)("%s preserves typed process and source failures", async (method) => {
    for (const failure of [
      new WorkerProcessFailure("worker_command_spawn_failed", "retryable", "spawn", "", null, { failureScope: "executor", errno: "EMFILE" }),
      new WorkerProcessFailure("worker_command_unavailable", "retryable", "missing", "", null, { failureScope: "configuration" }),
      new WorkflowFailure("source_media_invalid", "permanent", "invalid"),
      new WorkflowFailure("worker_command_timeout", "retryable", "timeout"),
    ]) await expect(detectors(async () => { throw failure; })[method](detection)).rejects.toBe(failure);
  });

  test.each([2, 3, 5])("detector startup exit %s is configuration recovery, not content", async (exitCode) => {
    const d = detectors(async (request) => {
      expect(request.acceptableExitCodes).toEqual([0, 2, 3, 4, 5]);
      return { exitCode, stdout: Buffer.from('{"error":"helper startup failed"}') };
    });
    await expect(d.detectMultiFacePath(detection)).rejects.toMatchObject({ code: "worker_command_unavailable", failureScope: "configuration" });
  });

  test("unreadable detector input retries and malformed JSON cannot become empty evidence", async () => {
    await expect(detectors(async () => ({ exitCode: 4, stdout: Buffer.from('{"error":"cannot open video"}') })).detectFacePath(detection)).rejects.toMatchObject({ code: "analysis_input_unavailable", disposition: "retryable" });
    for (const out of ["not json", '{}', '{"samples":[{"t":"bad","faces":[]}]}']) {
      await expect(detectors(async () => ({ exitCode: 0, stdout: Buffer.from(out) })).detectMultiFacePath(detection)).rejects.toMatchObject({ code: "analysis_output_invalid", disposition: "retryable" });
    }
  });

  test("successful empty content remains available, with no camera cuts", async () => {
    const d = detectors(async (request) => ({ exitCode: 0, stdout: Buffer.from(request.command === "ffmpeg" ? "" : request.args[0]?.endsWith("pip_detect.py") ? '{"movingPxFrac":null,"insufficientSamples":true,"candidates":[]}' : '{"samples":[]}') }));
    expect(await d.detectFacePath(detection)).toEqual({ samples: [] });
    expect(await d.detectMultiFacePath(detection)).toEqual({ samples: [] });
    expect(await d.detectPipPath(detection)).toEqual({ movingPxFrac: null, insufficientSamples: true, candidates: [] });
    expect(await d.detectSceneCuts(detection)).toEqual([]);
  });

  test("cancellation after an adapter ignores abort cannot publish detector output", async () => {
    const controller = new AbortController(); const reason = new Error("claim lost");
    const d = detectors(async () => { controller.abort(reason); return { exitCode: 0, stdout: Buffer.from('{"samples":[]}') }; }, controller.signal);
    await expect(d.detectMultiFacePath(detection)).rejects.toBe(reason);
  });
});

test("real Python helpers fail on inference exceptions or zero decoded frames", async () => {
  for (const [script, inference] of [["reframe_detect.py", true], ["reframe_detect.py", false], ["pip_detect.py", false]] as const) {
    const scriptPath = fileURLToPath(new URL(`../scripts/${script}`, import.meta.url));
    const fakeDetector = `
import runpy, sys, types
class Capture:
    def isOpened(self): return True
    def get(self, prop): return 30 if prop == 3 else 2
    def set(self, *_): pass
    def read(self): return (${inference ? "True, types.SimpleNamespace(shape=(2, 2, 3))" : "False, None"})
    def release(self): pass
class Detector:
    def detect(self, _): raise RuntimeError("transient inference fault")
cv = types.SimpleNamespace(VideoCapture=lambda _: Capture(), CAP_PROP_FRAME_WIDTH=1, CAP_PROP_FRAME_HEIGHT=2, CAP_PROP_FPS=3, CAP_PROP_POS_MSEC=4, FaceDetectorYN=types.SimpleNamespace(create=lambda *a, **kw: Detector()))
sys.modules["cv2"] = cv
sys.modules["numpy"] = types.SimpleNamespace()
sys.argv = [${JSON.stringify(scriptPath)}, "input.mp4", "0", "1", "4", "model.onnx"]
runpy.run_path(sys.argv[0], run_name="__main__")
`;
    const result = await productionWorkerProcessModule.execute({ command: "python3", args: ["-c", fakeDetector], captureStdout: true, acceptableExitCodes: [4, 6], signal: new AbortController().signal, deadlineMs: 10000 });
    expect(result.exitCode).toBe(inference ? 6 : 4);
    expect(JSON.parse(result.stdout.toString())).toEqual({ error: inference ? "face inference failed" : "no decoded frames" });
  }
});
