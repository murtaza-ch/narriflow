import type { WorkerProcessModule } from "../worker-process";

/** Whole-source mono audio for transcription. Admission precedes this command. */
export async function extractTranscriptionAudio(input: {
 workerProcess: WorkerProcessModule;
 sourcePath: string;
 outputPath: string;
 signal: AbortSignal;
 deadlineMs: number;
 localOnly?: boolean;
 audioStreamIndex?: number;
}): Promise<void> {
 await input.workerProcess.execute({
  command: "ffmpeg",
  args: ["-y",...(input.localOnly?["-nostdin","-protocol_whitelist","file,pipe","-threads","2","-filter_threads","2","-filter_complex_threads","2"]:[]),
   "-i",input.sourcePath,...(input.audioStreamIndex===undefined?[]:["-map",`0:${input.audioStreamIndex}`]),"-vn","-ac","1","-ar","16000","-b:a","64k",
   ...(input.localOnly?["-threads","2"]:[]),input.outputPath],
  signal: input.signal,
  deadlineMs: input.deadlineMs,
 });
}
