import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createDubbingExecution, type DubbingExecution } from "@narriflow/services/dubbing-execution";
import { createExecutionStorage } from "@narriflow/services/execution-storage";
import { createAssignedArtifactStorage } from "./artifact-storage";

// Stop immediately before SQL: the actual control and Dubbing factory must
// validate assigned R2 evidence before opening the mutation transaction.
async function prepare(stage: "translation_intent" | "translation_result", maxBytes: number, textLength = 0) {
  const attemptToken = randomUUID(), owner = randomUUID(), artifactId = randomUUID(), bindingHash = "a".repeat(64);
  const reference = { dispatchId: randomUUID(), deploymentEpoch: 1, generation: 1, kind: "modal_execution", subject: { kind: "workflow_run", id: randomUUID() }, inputHash: "b".repeat(64) } as const;
  const assignment = { id: artifactId, attemptToken, owner, role: "probe", bindingHash, contentType: "application/json", maxBytes: BigInt(maxBytes), storageKey: `execution/1/${attemptToken}/${owner}/${artifactId}`, committedAt: null };
  const value = { version: 1, kind: "dubbing_checkpoint", stage, dubId: randomUUID(), requestHash: "c".repeat(64),
    ...(stage === "translation_intent" ? { bodySha256: "d".repeat(64) } : { text: "e".repeat(textLength), providerRequestId: "resp_offline" }) };
  const bytes = new TextEncoder().encode(JSON.stringify(value)), sha256 = createHash("sha256").update(bytes).digest("hex");
  const metadata = { key: assignment.storageKey, httpEtag: '"sealed"', size: bytes.length, httpMetadata: { contentType: "application/json" },
    customMetadata: { "execution-artifact-id": artifactId, "execution-binding-hash": bindingHash }, checksums: {} };
  let reads = 0, transactions = 0, rangeLength = 0;
  const transactionBoundary = Error("validated_evidence_before_mutation");
  const database = { executionInboxReceipt: { findUnique: async () => null },
    executionAttempt: { findUnique: async () => ({ attemptToken, dispatchId: reference.dispatchId, deploymentEpoch: 1, generation: 1, inputHash: reference.inputHash,
      dispatch: { kind: reference.kind, subjectKind: reference.subject.kind, subjectId: reference.subject.id } }), findUniqueOrThrow: async () => ({ attemptToken }) },
    executionArtifact: { findUnique: async () => assignment }, $transaction: async () => { transactions++;throw transactionBoundary; } } as unknown as PrismaClient;
  const artifacts = createAssignedArtifactStorage({ head: async () => metadata, get: async (_key: string, options: R2GetOptions) => { reads++;rangeLength = options.range?.length ?? 0;return { ...metadata, body: new Blob([bytes]).stream() }; } } as unknown as R2Bucket);
  const runtime = createDubbingExecution({ database, domain: { loadInput: async () => ({}) } as unknown as DubbingExecution, artifacts,
    storage: createExecutionStorage({ accountId: "a".repeat(32), bucket: "offline", accessKeyId: "fixture", secretAccessKey: "fixture" }), deliverWakes: async () => {} });
  const result = runtime.control.execute({ command: { action: "commit-artifact", fence: { reference, attemptToken, owner },
    artifact: { artifactId, role: "probe", bindingHash, contentType: "application/json", byteLength: bytes.length, etag: metadata.httpEtag, sha256 } },
    verifiedRequest: { requestHash: "f".repeat(64), metadata: { version: 1, keyId: "offline", audience: "executor-control", method: "POST", canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: 1, deliveryId: randomUUID(), signature: "0".repeat(64) } } });
  return { result, transactionBoundary, reads: () => reads, transactions: () => transactions, rangeLength: () => rangeLength };
}

test("real Dubbing factory accepts a small intent through the Worker assigned-object adapter", async () => {
  const f = await prepare("translation_intent", 65536);
  await expect(f.result).rejects.toBe(f.transactionBoundary);expect(f.reads()).toBe(1);expect(f.transactions()).toBe(1);expect(f.rangeLength()).toBe(65537);
});

test("the declared one MiB translation result may exceed 64 KiB", async () => {
  const f = await prepare("translation_result", 1024 ** 2, 70000);
  await expect(f.result).rejects.toBe(f.transactionBoundary);expect(f.reads()).toBe(1);expect(f.transactions()).toBe(1);expect(f.rangeLength()).toBe(1048577);
});

test("the core assignment cap still rejects an oversized 64 KiB probe before R2 or SQL", async () => {
  const f = await prepare("translation_result", 65536, 70000);
  await expect(f.result).rejects.toMatchObject({ code: "artifact_invalid" });expect(f.reads()).toBe(0);expect(f.transactions()).toBe(0);
});
