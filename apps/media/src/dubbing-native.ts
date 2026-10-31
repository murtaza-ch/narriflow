import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dubbingCheckpointSchema, dubbingExecutionInputSchema, type DubbingCheckpoint } from "@narriflow/validators/dubbing-execution";
import { encodeDubbingInput } from "@narriflow/services/dubbing-input";
import { DUBBING_STAGE_OUTPUTS, dubSpeechRequestBody, dubTranslationRequestBody, shouldTranslateDub, type DubbingArtifactStage } from "@narriflow/services/dubbing-policy";
import { productionWorkerProcessModule } from "./worker-process";
import { muxDubbedVideo, probeDubbedMediaDuration } from "./tasks/dub-mix";
import { submitDubSpeech, submitDubTranslation, type DubProviderRequest } from "./dubbing-provider";

type Request = { operation: "authority" } | { operation: "download"; sourceName: string; path: string; maxBytes: number }
  | { operation: "checkpoint"; stage: "translation_intent" | "translation_result" | "speech_intent" | "final_result"; path: string }
  | { operation: "publish"; stage: "audio" | "video"; path: string };
export type DubbingNativeRequest = Request;
export interface DubbingNativeOptions {
  work: string; apiKey?: string; signal: AbortSignal; sourceNames: readonly string[]; stages: readonly DubbingArtifactStage[];
  request(command: Request): Promise<unknown>;
  /** Trusted transport injection for provider HTTP gates. A command cannot set an endpoint. */
  providerRequest?: DubProviderRequest;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** A paid stage requires its sealed intent and a fresh authority response.
 * Historical sealed results are read once and never cause a new provider POST. */
export async function executeDubbing(raw: unknown, options: DubbingNativeOptions): Promise<{ outcome: "completed" | "rejected" | "unknown" }> {
  const input = dubbingExecutionInputSchema.parse(raw);await encodeDubbingInput(input);
  const work = await realpath(options.work);
  if ((await lstat(options.work)).isSymbolicLink() || new Set(options.stages).size !== options.stages.length || !options.stages.includes("final_result") ||
    options.stages.some(stage => !(stage in DUBBING_STAGE_OUTPUTS)) || new Set(options.sourceNames).size !== options.sourceNames.length ||
    options.sourceNames.some(name => !["base_video", "translation_result", "dub_audio", "dub_video"].includes(name)) || !options.sourceNames.includes("base_video")) throw Error("dubbing_command_invalid");
  const identity = { version: 1 as const, kind: "dubbing_checkpoint" as const, dubId: input.request.dubId, requestHash: input.requestHash };
  const checkpoint = async (value: DubbingCheckpoint) => {
    options.signal.throwIfAborted();const evidence = dubbingCheckpointSchema.parse(value);
    if (!options.stages.includes(evidence.stage)) throw Error("dubbing_stage_unavailable");
    const path = join(work, `${evidence.stage}.json`);await writeFile(path, JSON.stringify(evidence), { flag: "wx", mode: 0o600, signal: options.signal });
    await options.request({ operation: "checkpoint", stage: evidence.stage, path });
  };
  const download = async (sourceName: string, path: string, maxBytes: number) => {
    if (!options.sourceNames.includes(sourceName)) throw Error("dubbing_source_unavailable");
    await options.request({ operation: "download", sourceName, path, maxBytes });
  };
  const paid = async (stage: "translation_intent" | "speech_intent", body: object) => {
    if (!options.apiKey || options.apiKey.length > 8192 || /[\r\n\0]/.test(options.apiKey)) throw Error("dub_provider_configuration_invalid");
    await checkpoint({ ...identity, stage, bodySha256: hash(JSON.stringify(body)) });
    await options.request({ operation: "authority" });options.signal.throwIfAborted();
  };
  const failed = async (providerStage: "translation" | "speech", failure: { outcome: "unknown" } | { outcome: "rejected"; httpStatus: number }) => {
    await checkpoint(dubbingCheckpointSchema.parse({ ...identity, stage: "final_result", providerStage, ...failure }));return { outcome: failure.outcome };
  };
  const baseVideo = join(work, "base.mp4");await download("base_video", baseVideo, 10 * 1024 ** 3);
  let text: string;
  if (options.sourceNames.includes("translation_result")) {
    const path = join(work, "recovered-translation.json");await download("translation_result", path, 1024 ** 2);
    const result = dubbingCheckpointSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (result.stage !== "translation_result" || result.dubId !== input.request.dubId || result.requestHash !== input.requestHash) throw Error("dubbing_source_changed");text = result.text;
  } else {
    if (shouldTranslateDub(input.request.sourceLanguageCode, input.request.targetLanguageCode)) {
      const body = dubTranslationRequestBody(input.request);await paid("translation_intent", body);
      const result = await submitDubTranslation(body, { apiKey: options.apiKey!, signal: options.signal, request: options.providerRequest });
      if (result.outcome !== "completed") return failed("translation", result);
      text = result.text;await checkpoint({ ...identity, stage: "translation_result", text, providerRequestId: result.providerRequestId });
    } else { text = input.request.script;await checkpoint({ ...identity, stage: "translation_result", text, providerRequestId: null }); }
  }
  const audioPath = join(work, "dub.mp3");
  if (options.sourceNames.includes("dub_audio")) await download("dub_audio", audioPath, 64 * 1024 ** 2);
  else {
    const body = dubSpeechRequestBody(input.request, text);await paid("speech_intent", body);
    const result = await submitDubSpeech(body, audioPath, { apiKey: options.apiKey!, signal: options.signal, request: options.providerRequest });
    if (result.outcome !== "completed") return failed("speech", result);
    try { const probe = await productionWorkerProcessModule.inspectMedia({ sourcePath: audioPath, signal: options.signal, deadlineMs: 30_000, localOnly: true });
      if (!probe.hasAudio) throw Error();
    } catch (error) {
      options.signal.throwIfAborted();
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(error.code) ? error.code : "dub_audio_invalid";
      console.warn(JSON.stringify({ level: "warn", message: "dubbing_audio_inspection_unconfirmed", errorCode: code }));
      return failed("speech", { outcome: "unknown" });
    }
    await options.request({ operation: "publish", stage: "audio", path: audioPath });
  }
  const outputPath = join(work, "dub.mp4");
  if (options.sourceNames.includes("dub_video")) await download("dub_video", outputPath, 10 * 1024 ** 3);
  else { await muxDubbedVideo({ workerProcess: productionWorkerProcessModule, signal: options.signal, videoPath: baseVideo, audioPath, outputPath, localOnly: true });
    await options.request({ operation: "publish", stage: "video", path: outputPath }); }
  const measured = async (path: string, maximum: number) => {
    const size = (await stat(path)).size;if (size < 1 || size > maximum) throw Error("dubbing_result_invalid");
    const digest = createHash("sha256");for await (const part of createReadStream(path)) digest.update(part);return { byteLength: size, sha256: digest.digest("hex") };
  };
  const duration = await probeDubbedMediaDuration(productionWorkerProcessModule, options.signal, outputPath, true).catch(() => null);options.signal.throwIfAborted();
  await checkpoint({ ...identity, stage: "final_result", outcome: "completed", audio: await measured(audioPath, 64 * 1024 ** 2), video: await measured(outputPath, 10 * 1024 ** 3),
    probe: duration !== null && Number.isFinite(duration) && duration > 0 ? { state: "ready", durationSec: duration } : { state: "unavailable", reason: "dub_duration_unavailable" } });
  return { outcome: "completed" };
}
