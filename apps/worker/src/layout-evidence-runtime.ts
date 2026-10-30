import { fileURLToPath } from "node:url";
import { WorkflowFailure } from "@narriflow/services";
import type { LayoutDetectionInput, LayoutEvidenceDetectors, PipDetectionResult } from "./layout-evidence";
import type { RenderConfig } from "./render-config";
import { WorkerProcessFailure, type WorkerProcessModule } from "./worker-process";
import type { FaceSample } from "./tasks/reframe";
import type { MultiFaceSample } from "./tasks/two-up";

/** Process failures stay typed. Empty detector output alone means no content. */
export function createLayoutEvidenceDetectors(input: {
  workerProcess: WorkerProcessModule;
  config: Readonly<RenderConfig>;
  signal: AbortSignal;
  rethrowControl?: (error: unknown) => void;
}): LayoutEvidenceDetectors {
  const { workerProcess, config, signal } = input;
  const execute = async (command: string, args: string[], detector = false) => {
    signal.throwIfAborted();
    try {
      const result = await workerProcess.execute({
        command, args, signal, deadlineMs: config.probeCommandTimeoutMs, captureStdout: true,
        // Python helpers reserve these exits for usage, dependencies, unreadable
        // media and model initialization. Preserve configuration vs IO failure.
        ...(detector ? { acceptableExitCodes: [0, 2, 3, 4, 5] } : {}),
      });
      signal.throwIfAborted();
      if (detector && [2, 3, 5].includes(result.exitCode)) throw new WorkerProcessFailure("worker_command_unavailable", "retryable", "Layout detector configuration unavailable", "", result.exitCode, { executableClass: "python", failureScope: "configuration" });
      if (result.exitCode !== 0) throw new WorkflowFailure("analysis_input_unavailable", "retryable", "Layout detector could not read its input");
      return result.stdout.toString("utf8");
    } catch (error) {
      signal.throwIfAborted(); input.rethrowControl?.(error); throw error;
    }
  };
  const invalid = (): never => { throw new WorkflowFailure("analysis_output_invalid", "retryable", "Layout detector returned malformed output"); };
  const parse = (out: string): Record<string, unknown> => {
    let value: unknown;
    try { value = JSON.parse(out); } catch { return invalid(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const parsed = value as Record<string, unknown>;
    if (parsed.error) {
      if (typeof parsed.error === "string" && /usage:|import failed:|detector init failed:/.test(parsed.error)) throw new WorkerProcessFailure("worker_command_unavailable", "retryable", "Layout detector configuration unavailable", "", null, { executableClass: "python", failureScope: "configuration" });
      throw new WorkflowFailure("analysis_input_unavailable", "retryable", "Layout detector could not read its input");
    }
    return parsed;
  };
  const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const run = async (name: string, params: LayoutDetectionInput, multi = false) => {
    const script = fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
    return parse(await execute(config.reframePython, [script, params.sourcePath, String(params.startSec), String(params.durationSec), ...(name === "reframe_detect.py" ? [String(config.reframeSampleFps), config.reframeModelPath, ...(multi ? ["--multi"] : [])] : [])], true));
  };
  const detectFacePath = async (params: LayoutDetectionInput): Promise<{ samples: FaceSample[] }> => {
    const parsed = await run("reframe_detect.py", params);
    if (!Array.isArray(parsed.samples)) return invalid();
    const samples = parsed.samples.map((sample: unknown): FaceSample => {
      if (!object(sample) || !number(sample.t) || !(sample.cx === null || number(sample.cx))) return invalid();
      return { t: sample.t, cx: sample.cx };
    });
    return { samples };
  };
  const detectMultiFacePath = async (params: LayoutDetectionInput): Promise<{ samples: MultiFaceSample[] }> => {
    const parsed = await run("reframe_detect.py", params, true);
    if (!Array.isArray(parsed.samples)) return invalid();
    const samples = parsed.samples.map((sample: unknown): MultiFaceSample => {
      if (!object(sample) || !number(sample.t) || sample.faces !== undefined && !Array.isArray(sample.faces)) return invalid();
      const faces = ((sample.faces ?? []) as unknown[]).map((face): MultiFaceSample["faces"][number] => {
        if (!object(face) || !number(face.cx) || !number(face.cy) || !number(face.w) || !number(face.h) || !number(face.score) || face.m != null && !number(face.m) || face.fm != null && !number(face.fm)) return invalid();
        return { cx: face.cx, cy: face.cy, w: face.w, h: face.h, score: face.score, ...(face.m !== undefined ? { m: face.m as number | null } : {}), ...(face.fm !== undefined ? { fm: face.fm as number | null } : {}) };
      });
      if (sample.content === undefined) return { t: sample.t, faces };
      const content = sample.content;
      if (!object(content) || !number(content.edge) || !number(content.text)) return invalid();
      return { t: sample.t, faces, content: { edge: content.edge, text: content.text } };
    });
    return { samples };
  };
  const detectPipPath = async (params: LayoutDetectionInput): Promise<PipDetectionResult> => {
    const parsed = await run("pip_detect.py", params);
    if (!Array.isArray(parsed.candidates) || parsed.movingPxFrac != null && !number(parsed.movingPxFrac)) return invalid();
    const candidates = parsed.candidates.map((candidate: unknown): PipDetectionResult["candidates"][number] => {
      if (!object(candidate) || !number(candidate.x) || !number(candidate.y) || !number(candidate.w) || !number(candidate.h) || !number(candidate.areaFrac) || !number(candidate.fillFrac) || typeof candidate.cornerAdjacent !== "boolean" || !number(candidate.medianDiffMean)) return invalid();
      return { x: candidate.x, y: candidate.y, w: candidate.w, h: candidate.h, areaFrac: candidate.areaFrac, fillFrac: candidate.fillFrac, cornerAdjacent: candidate.cornerAdjacent, medianDiffMean: candidate.medianDiffMean };
    });
    return { movingPxFrac: parsed.movingPxFrac as number | null | undefined ?? null, insufficientSamples: Boolean(parsed.insufficientSamples), candidates };
  };
  const detectSceneCuts = async (params: LayoutDetectionInput): Promise<number[]> => {
    const out = await execute("ffmpeg", [
      "-hide_banner", "-nostats", ...(params.startSec > 0 ? ["-ss", String(params.startSec)] : []),
      "-t", String(params.durationSec), "-i", params.sourcePath, "-vf",
      `setpts=PTS-STARTPTS,settb=AVTB,scale=320:-2,select='gt(scene,${config.reframeSceneThreshold})',metadata=print:file=-`,
      "-an", "-f", "null", "-",
    ]);
    return [...out.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)].map((match) => Number(match[1]));
  };
  return { detectFacePath, detectMultiFacePath, detectPipPath, detectSceneCuts };
}
