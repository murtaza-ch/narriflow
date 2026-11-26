import { expect, test } from "bun:test";
import { contentPackSchema, DEFAULT_CAPTION_PRESET, studioEditsSchema, type ClipSelectionInput } from "@narriflow/validators";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { createClipSelectionControl, type ClipSelectionControlPorts } from "./clip-selection-control";
import { clipSelectionBytesHash, clipSelectionWindowInputHash, encodeClipSelectionInput } from "./clip-selection-input";
import { CLIP_DETECTION_JSON_SCHEMA, SYSTEM_PROMPT } from "./clip-selection-policy";

const parent = { id: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002", generation: 1, deploymentEpoch: 1, inputHash: "a".repeat(64) };
const schemaHash = (schema: unknown) => clipSelectionBytesHash(new TextEncoder().encode(JSON.stringify(schema)));

/** The response schema as it was before Clip Emphasis Words. */
function previousSchema() {
  const schema = structuredClone(CLIP_DETECTION_JSON_SCHEMA) as unknown as { properties: { clips: { items: { required: string[]; properties: Record<string, unknown> } } } };
  const items = schema.properties.clips.items;
  items.required = items.required.filter((name) => name !== "emphasis_words");
  delete items.properties.emphasis_words;
  return schema;
}

function capsule(responseSchemaHash: string): ClipSelectionInput {
  return { version: 1, parent, transcript: { id: "00000000-0000-4000-8000-000000000003", generation: 1, attemptId: null, contentHash: "b".repeat(64), sourceRevision: 1, sourceAudioId: null, sourceAudioBindingHash: null },
    planning: { projectTitle: "Title", contentPack: contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1" }),
      sourceDurationSec: 600, sourceProbeDurationSec: 600, fullText: "We grew fast.", speakerCount: 1, sourceLanguageCode: "en", audienceDataLine: null,
      utterances: [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 1, endSec: 4, text: "We grew fast.", confidence: null, words: [] }] },
    editor: { captionPreset: DEFAULT_CAPTION_PRESET, studioEdits: studioEditsSchema.parse({}), sourceDurationSec: 600, wholeSource: false,
      cleanup: { removeSilences: false, removeFillerWords: false, quietRanges: null, languageCode: "en", aiFillers: null }, emojiPicks: null },
    provider: { model: "gpt-6-luna", reasoningEffort: "medium", maxOutputTokens: 32000 }, systemPrompt: SYSTEM_PROMPT, responseSchemaHash };
}

async function runWindow(responseSchemaHash: string) {
  const encoded = await encodeClipSelectionInput(capsule(responseSchemaHash));
  const input = { storageKey: "input", etag: '"e"', sha256: encoded.sha256, byteLength: encoded.byteLength };
  const window = { selectionHash: encoded.sha256, windowIndex: 0, startSec: 0, endSec: 600 };
  const reference = { subject: { id: "00000000-0000-4000-8000-000000000004" }, inputHash: await clipSelectionWindowInputHash(window) } as unknown as ExecutionDispatchReference;
  const calls: string[] = [];
  const ports = {
    preparation: { readWindow: async () => ({ parent, status: "queued", ...window, input }) },
    lifecycle: {
      admit: async () => ({ kind: "acquired", attempt: {}, input, windowIndex: 0, operationDeadlineAt: new Date(), leaseExpiresAt: new Date(), dispatchIds: [] }),
      retry: async (_attempt: unknown, failure: { code: string }) => { calls.push(`retry:${failure.code}`); return { kind: "retried", dispatchIds: [] }; },
      start: async () => { calls.push("start"); return { kind: "superseded" }; },
      expire: async () => ({ kind: "superseded", dispatchIds: [] }),
    },
    storage: { read: async () => encoded.bytes, write: async () => { throw new Error("unused"); } },
    deliver: async () => {},
    provider: { generate: async () => { throw new Error("unused"); } },
  } as unknown as ClipSelectionControlPorts;
  await createClipSelectionControl(ports).runWindow(reference);
  return calls;
}

test("the response schema hash covers Clip Emphasis Words", async () => {
  expect(await schemaHash(CLIP_DETECTION_JSON_SCHEMA)).not.toBe(await schemaHash(previousSchema()));
});

test("a window frozen under the previous response schema never reaches the provider", async () => {
  expect(await runWindow(await schemaHash(previousSchema()))).toEqual(["retry:selection_input_invalid"]);
  expect(await runWindow(await schemaHash(CLIP_DETECTION_JSON_SCHEMA))).toEqual(["start"]);
});
