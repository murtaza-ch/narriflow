import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSyntheticSelectionCapsule, syntheticSelectionProviderReply } from "./selection-fixture";
import { encodeClipSelectionInput, clipSelectionWindowInputHash } from "@narriflow/services/clip-selection-input";
import { buildClipSelectionPlan } from "@narriflow/services/clip-selection-plan";

const directory = process.argv[2];
if (!directory?.startsWith("/tmp/narriflow-selection-memory-") && !directory?.startsWith("/private/tmp/narriflow-selection-memory-")) throw new Error("Synthetic fixture requires its temporary directory");
const capsule = await createSyntheticSelectionCapsule(), parent = capsule.parent;
const input = await encodeClipSelectionInput(capsule), plan = buildClipSelectionPlan(capsule.planning);
if (plan.kind !== "selection" || plan.windows.length !== 6) throw new Error("Fixture must exercise all six windows");
const inputKey = `projects/${parent.projectId}/selection/${parent.id}/${input.sha256}.json`;
const windows = await Promise.all(plan.windows.map(async window => ({ reference: { dispatchId: crypto.randomUUID(), deploymentEpoch: 1, generation: 1, kind: "operation_driver", subject: { kind: "clip_selection_window", id: crypto.randomUUID() },
  inputHash: await clipSelectionWindowInputHash({ selectionHash: input.sha256, windowIndex: window.windowIndex, startSec: window.startSec, endSec: window.endSec }) },
  metadata: { parent, status: "queued", selectionHash: input.sha256, windowIndex: window.windowIndex, startSec: window.startSec, endSec: window.endSec,
    input: { storageKey: inputKey, etag: '"synthetic-input"', sha256: input.sha256, byteLength: input.byteLength } } })));
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "input.json"), input.bytes);
await writeFile(join(directory, "provider.json"), syntheticSelectionProviderReply());
await writeFile(join(directory, "metadata.json"), JSON.stringify({ sourceSeconds: 10800, words: 28800, utterances: 960, inputKey, inputBytes: input.byteLength, inputHash: input.sha256, windows }));
