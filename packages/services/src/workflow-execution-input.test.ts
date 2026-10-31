import { expect, test } from "bun:test";
import { workflowRunExecutionInputHash, type WorkflowRunExecutionInput } from "./workflow-execution-input";

const input: WorkflowRunExecutionInput = {
  id: "ce4d7e7e-caae-4d85-80f8-17f55e2eaf79", projectId: "05bfd4bb-8ce2-455c-a598-1328f676a288", stage: "stt",
  contentPackId: "ec19cc0e-7c98-4246-adff-4a0b05d89102", generation: 1, deploymentEpoch: 3,
  sourceAudioId: "d5ab39a2-80e7-45d1-8da8-5bc90097075e", sourceRevision: 2,
};

test("workflow dispatch hashes the frozen server provenance independently of caller property order", async () => {
  // Independently calculated with Python hashlib.sha256 over compact UTF-8 JSON.
  expect(await workflowRunExecutionInputHash(input)).toBe("227e8943698c51dc3a5600ba50440939618f05f43d44c7f4eceb08d51b4cd7cc");
  expect(await workflowRunExecutionInputHash({ sourceRevision: input.sourceRevision, sourceAudioId: input.sourceAudioId,
    deploymentEpoch: input.deploymentEpoch, generation: input.generation, contentPackId: input.contentPackId,
    stage: input.stage, projectId: input.projectId, id: input.id })).toBe(await workflowRunExecutionInputHash(input));
  for (const changed of [{ ...input, generation: 2 }, { ...input, deploymentEpoch: 4 }, { ...input, sourceRevision: 3 },
    { ...input, sourceAudioId: null }, { ...input, contentPackId: null }, { ...input, stage: "moment_detection" }]) {
    expect(await workflowRunExecutionInputHash(changed)).not.toBe(await workflowRunExecutionInputHash(input));
  }
});

test("selection parent authority binds the completed Transcript generation while STT authority binds only its source audio", async () => {
  const transcript = { id: "636cb598-8264-438e-a008-1fb23b75395a", generation: 2, attemptId: "1600b42c-702d-4fd5-a141-705e250617a1" };
  const selection = { ...input, stage: "moment_detection", sourceTranscript: transcript };
  // Independently calculated from compact ordered JSON with Python hashlib.
  expect(await workflowRunExecutionInputHash(selection)).toBe("e5041e008fddb037b522e03ecc1dcdfccaa5a0d740e8ffd7ad414222a64a741f");
  expect(await workflowRunExecutionInputHash({ ...selection, sourceTranscript: { ...transcript, generation: 3 } })).not.toBe(await workflowRunExecutionInputHash(selection));
  expect(await workflowRunExecutionInputHash({ ...selection, sourceTranscript: { ...transcript, attemptId: crypto.randomUUID() } })).not.toBe(await workflowRunExecutionInputHash(selection));
  expect(await workflowRunExecutionInputHash({ ...input, sourceTranscript: transcript })).toBe(await workflowRunExecutionInputHash(input));
});
