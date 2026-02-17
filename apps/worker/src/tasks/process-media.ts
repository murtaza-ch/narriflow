import type { OutputType } from "@clipforge/validators";

export interface ProcessMediaTaskInput {
  projectId: string;
  sourceMediaUrl: string;
  outputs: OutputType[];
}

export async function processMediaTask(input: ProcessMediaTaskInput) {
  return {
    accepted: true,
    message: "Worker task scaffolded. Integrate FFmpeg pipeline stages here.",
    input,
  };
}
