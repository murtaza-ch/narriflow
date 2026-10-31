import type { WorkerProcessModule } from "../worker-process";

/** Whole-source mono audio for transcription. Admission precedes this command. */
export async function extractTranscriptionAudio(input: {
 workerProcess: WorkerProcessModule;
 sourcePath: string;
 outputPath: string;
 signal: AbortSignal;
 deadlineMs: number;
}): Promise<void> {
 await input.workerProcess.execute({
  command: "ffmpeg",
  args: ["-y", "-i", input.sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", input.outputPath],
  signal: input.signal,
  deadlineMs: input.deadlineMs,
 });
}
