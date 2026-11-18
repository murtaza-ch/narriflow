import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dubbingCheckpointSchema, dubbingExecutionInputSchema, type DubbingCheckpoint } from "@narriflow/validators/dubbing-execution";
import { encodeDubbingInput } from "@narriflow/services/dubbing-input";
import { DUBBING_STAGE_OUTPUTS, dubSpeechRequestBody, dubTranslationRequestBody, shouldTranslateDub, type DubbingArtifactStage } from "@narriflow/services/dubbing-policy";
import { productionWorkerProcessModule } from "./worker-process";
import { mixDubAudio, probeDubbedMediaDuration, trimDubClip } from "./tasks/dub-mix";
import { dubCaptionWords, placeDubSegments } from "./tasks/dub-placement";
import { submitDubSpeech, submitDubTranslation, type DubProviderRequest } from "./dubbing-provider";

type Request = { operation: "authority" } | { operation: "download"; sourceName: string; path: string; maxBytes: number }
  | { operation: "checkpoint"; stage: "translation_intent" | "translation_result" | "speech_intent" | "timing" | "final_result"; path: string }
  | { operation: "publish"; stage: "audio"; path: string };
export type DubbingNativeRequest = Request;
export interface DubbingNativeOptions {
  work: string; apiKey?: string; signal: AbortSignal; sourceNames: readonly string[]; stages: readonly DubbingArtifactStage[];
  request(command: Request): Promise<unknown>;
  /** Trusted transport injection for provider HTTP gates. A command cannot set an endpoint. */
  providerRequest?: DubProviderRequest;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const SOURCE_NAMES = ["translation_result", "dub_timing", "dub_audio"];
function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(error.code) ? error.code : "dub_audio_invalid";
}

/** A paid stage requires its sealed intent and a fresh authority response before every POST.
 * Historical sealed results are read once and never cause a new provider POST. */
export async function executeDubbing(raw: unknown, options: DubbingNativeOptions): Promise<{ outcome: "completed" | "rejected" | "unknown" | "unfit" }> {
  const input = dubbingExecutionInputSchema.parse(raw);await encodeDubbingInput(input);
  const work = await realpath(options.work), request = input.request;
  if ((await lstat(options.work)).isSymbolicLink() || new Set(options.stages).size !== options.stages.length || !options.stages.includes("final_result") ||
    options.stages.some(stage => !(stage in DUBBING_STAGE_OUTPUTS)) || new Set(options.sourceNames).size !== options.sourceNames.length ||
    options.sourceNames.some(name => !SOURCE_NAMES.includes(name)) || options.sourceNames.includes("dub_audio") && !options.sourceNames.includes("dub_timing")) throw Error("dubbing_command_invalid");
  const identity = { version: 1 as const, kind: "dubbing_checkpoint" as const, dubId: request.dubId, requestHash: input.requestHash };
  const checkpoint = async (value: DubbingCheckpoint) => {
    options.signal.throwIfAborted();const evidence = dubbingCheckpointSchema.parse(value);
    if (!options.stages.includes(evidence.stage)) throw Error("dubbing_stage_unavailable");
    const path = join(work, `${evidence.stage}.json`);await writeFile(path, JSON.stringify(evidence), { flag: "wx", mode: 0o600, signal: options.signal });
    await options.request({ operation: "checkpoint", stage: evidence.stage as Extract<Request, { operation: "checkpoint" }>["stage"], path });
  };
  const download = async (sourceName: string, path: string, maxBytes: number) => {
    if (!options.sourceNames.includes(sourceName)) throw Error("dubbing_source_unavailable");
    await options.request({ operation: "download", sourceName, path, maxBytes });
  };
  /** The sealed intent precedes every POST it covers. */
  const intent = async (stage: "translation_intent" | "speech_intent", body: object) => {
    if (!options.apiKey || options.apiKey.length > 8192 || /[\r\n\0]/.test(options.apiKey)) throw Error("dub_provider_configuration_invalid");
    await checkpoint({ ...identity, stage, bodySha256: hash(JSON.stringify(body)) });
  };
  const authority = async () => { await options.request({ operation: "authority" });options.signal.throwIfAborted(); };
  const failed = async (providerStage: "translation" | "speech", failure: { outcome: "unknown" } | { outcome: "rejected"; httpStatus: number }) => {
    await checkpoint(dubbingCheckpointSchema.parse({ ...identity, stage: "final_result", providerStage, ...failure }));return { outcome: failure.outcome };
  };
  const measured = async (path: string, maximum: number) => {
    const size = (await stat(path)).size;if (size < 1 || size > maximum) throw Error("dubbing_result_invalid");
    const digest = createHash("sha256");for await (const part of createReadStream(path)) digest.update(part);return { byteLength: size, sha256: digest.digest("hex") };
  };
  const completed = async (audioPath: string) => {
    const duration = await probeDubbedMediaDuration(productionWorkerProcessModule, options.signal, audioPath, true).catch(() => null);options.signal.throwIfAborted();
    await checkpoint({ ...identity, stage: "final_result", outcome: "completed", audio: await measured(audioPath, 64 * 1024 ** 2),
      probe: duration !== null && Number.isFinite(duration) && duration > 0 ? { state: "ready", durationSec: duration } : { state: "unavailable", reason: "dub_duration_unavailable" } });
    return { outcome: "completed" as const };
  };
  const recovered = async <Stage extends "translation_result" | "timing">(sourceName: string, stage: Stage) => {
    const path = join(work, `recovered-${stage}.json`);await download(sourceName, path, 1024 ** 2);
    const result = dubbingCheckpointSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (result.stage !== stage || result.dubId !== request.dubId || result.requestHash !== input.requestHash || result.segments.length !== request.segments.length) throw Error("dubbing_source_changed");
    return result as Extract<DubbingCheckpoint, { stage: Stage }>;
  };

  // A sealed timing and audio only need their final result sealed again.
  if (options.sourceNames.includes("dub_audio")) {
    await recovered("dub_timing", "timing");
    const audioPath = join(work, "dub.mp3");await download("dub_audio", audioPath, 64 * 1024 ** 2);
    return completed(audioPath);
  }

  let texts: string[];
  if (options.sourceNames.includes("translation_result")) texts = (await recovered("translation_result", "translation_result")).segments;
  else if (shouldTranslateDub(request.sourceLanguageCode, request.targetLanguageCode)) {
    const body = dubTranslationRequestBody(request);await intent("translation_intent", body);await authority();
    const result = await submitDubTranslation(body, request.segments, { apiKey: options.apiKey!, signal: options.signal, request: options.providerRequest });
    if (result.outcome !== "completed") return failed("translation", result);
    texts = result.segments;await checkpoint({ ...identity, stage: "translation_result", segments: texts, providerRequestId: result.providerRequestId });
  } else { texts = request.segments.map(segment => segment.text);await checkpoint({ ...identity, stage: "translation_result", segments: texts, providerRequestId: null }); }

  // One intent covers every body. Calls are strictly sequential, each behind a fresh authority,
  // and the first failure ends the batch: a refusal settles rejected, anything else unknown.
  const bodies = texts.map(text => dubSpeechRequestBody(request, text));
  await intent("speech_intent", bodies);
  const clips: string[] = [];
  for (const [index, body] of bodies.entries()) {
    await authority();
    const path = join(work, `speech-${index}.mp3`), result = await submitDubSpeech(body, path, { apiKey: options.apiKey!, signal: options.signal, request: options.providerRequest });
    if (result.outcome !== "completed") return failed("speech", result);
    clips.push(path);
  }

  const trimmed: string[] = [], naturalSec: number[] = [];
  try {
    for (const [index, clip] of clips.entries()) {
      const path = join(work, `trim-${index}.wav`);
      await trimDubClip({ workerProcess: productionWorkerProcessModule, signal: options.signal, inputPath: clip, outputPath: path, localOnly: true });
      const natural = await probeDubbedMediaDuration(productionWorkerProcessModule, options.signal, path, true);
      if (natural === null || !Number.isFinite(natural) || natural <= 0) throw Object.assign(Error("dub_clip_empty"), { code: "dub_clip_empty" });
      trimmed.push(path);naturalSec.push(natural);
    }
  } catch (error) {
    options.signal.throwIfAborted();
    console.warn(JSON.stringify({ level: "warn", message: "dubbing_audio_inspection_unconfirmed", errorCode: errorCode(error) }));
    return failed("speech", { outcome: "unknown" });
  }

  const placement = placeDubSegments({ editedDurationSec: request.editedDurationSec, segments: request.segments.map((segment, index) => ({ startSec: segment.startSec, naturalSec: naturalSec[index]! })) });
  if (placement.kind === "unfit") {
    await checkpoint({ ...identity, stage: "final_result", outcome: "unfit", segmentIndex: placement.segmentIndex });return { outcome: "unfit" };
  }
  const placed = placement.segments;
  await checkpoint({ ...identity, stage: "timing", segments: placed.map((segment, index) => ({ startSec: segment.startSec, endSec: segment.endSec, tempo: segment.tempo,
    words: dubCaptionWords(texts[index]!, request.targetLanguageCode, segment.startSec, segment.endSec) })) });
  const audioPath = join(work, "dub.mp3");
  await mixDubAudio({ workerProcess: productionWorkerProcessModule, signal: options.signal, editedDurationSec: request.editedDurationSec, outputPath: audioPath, localOnly: true,
    clips: trimmed.map((path, index) => ({ path, startSec: placed[index]!.startSec, tempo: placed[index]!.tempo })) });
  await options.request({ operation: "publish", stage: "audio", path: audioPath });
  return completed(audioPath);
}
