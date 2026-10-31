import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { sourceAudioBindingSchema, type SourceAudioBinding } from "@narriflow/validators/execution";
import { selectProbeWindows, type LanguageProbeWindow } from "@narriflow/services/language-probe-contract";
import { buildProbeFfmpegArgs } from "./language-probe";
import type { WorkerProcessModule } from "./worker-process";

export const LANGUAGE_PROBE_MAX_BYTES = 2_000_000;
export class LanguageProbeMediaError extends Error {
  constructor(readonly code: "language_probe_input_invalid" | "language_probe_output_invalid") { super(code); this.name = "LanguageProbeMediaError"; }
}
export interface LanguageProbeFileInput {
  sourceAudio: SourceAudioBinding;
  source: { url: string; expiresAt: string };
  windows: readonly LanguageProbeWindow[];
  outputPath: string;
  artifactId: string;
  bindingHash: string;
}

/** Native preparation only. The existing acquired Ingest invocation owns its scoped upload and commit. */
export async function prepareLanguageProbeFile(input: LanguageProbeFileInput, ports: {
  signal: AbortSignal;
  workerProcess: Pick<WorkerProcessModule, "execute" | "inspectMedia">;
}) {
  ports.signal.throwIfAborted();
  const parsed = sourceAudioBindingSchema.safeParse(input.sourceAudio);
  const expiresAt = Date.parse(input.source.expiresAt);
  try {
    const url = new URL(input.source.url);
    if (!parsed.success || url.protocol !== "https:" || url.username || url.password || url.hash ||
      input.source.url.length > 8192 || !Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
      !isAbsolute(input.outputPath) || input.outputPath.includes("\0") || input.outputPath.length > 2048 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.artifactId) || !/^[a-f0-9]{64}$/.test(input.bindingHash)) throw new Error();
  } catch { throw new LanguageProbeMediaError("language_probe_input_invalid"); }
  if (!parsed.success) throw new LanguageProbeMediaError("language_probe_input_invalid");
  const windows = selectProbeWindows(parsed.data.durationSeconds);
  if (!windows || !Array.isArray(input.windows) || windows.length !== input.windows.length || windows.some((window, index) => {
    const reported = input.windows[index];
    return !reported || Object.keys(reported).length !== 2 || reported.startSec !== window.startSec || reported.durationSec !== window.durationSec;
  })) throw new LanguageProbeMediaError("language_probe_input_invalid");
  await ports.workerProcess.execute({ command: "ffmpeg", args: buildProbeFfmpegArgs(input.source.url, windows, input.outputPath,
    { ifMatch: parsed.data.object.etag, threads: 2 }), signal: ports.signal, deadlineMs: Math.min(90_000, expiresAt - Date.now()) });
  const output = await stat(input.outputPath);
  if (!output.isFile() || output.size < 44 || output.size > LANGUAGE_PROBE_MAX_BYTES) throw new LanguageProbeMediaError("language_probe_output_invalid");
  const probe = await ports.workerProcess.inspectMedia({ sourcePath: input.outputPath, signal: ports.signal, deadlineMs: 30_000 });
  const audio = probe.facts?.audios[0];
  if (probe.hasVideo || !probe.hasAudio || probe.facts?.format.name !== "wav" || audio?.codec !== "pcm_s16le" ||
    audio.sampleRate !== 16000 || audio.channels !== 1) throw new LanguageProbeMediaError("language_probe_output_invalid");
  const bytes = await readFile(input.outputPath);
  if (bytes.length !== output.size || (await stat(input.outputPath)).mtimeMs !== output.mtimeMs) throw new LanguageProbeMediaError("language_probe_output_invalid");
  return { artifactId: input.artifactId, bindingHash: input.bindingHash, path: input.outputPath, contentType: "audio/wav" as const,
    byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sourceAudioId: parsed.data.sourceAudioId,
    projectId: parsed.data.projectId, sourceRevision: parsed.data.sourceRevision };
}
