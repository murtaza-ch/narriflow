import { z } from "zod";
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ precision: 3 });
export const executionSnapshotOriginSchema = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value && !url.username && !url.password && !url.port; } catch { return false; }
}, "An explicit canonical HTTPS API origin is required");
export const fencedWorkerEvidenceSchema = z.strictObject({ origin: executionSnapshotOriginSchema, version: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/), admissionState: z.literal("fenced") });
export const executionSnapshotQuiescenceSchema = z.strictObject({
  stoppedAt: timestamp, writesDrainedAt: timestamp, capturedAt: timestamp, verifiedAt: timestamp, evidenceSha256: sha256,
  consumers: z.strictObject({ httpIngress: z.literal("fenced"), cron: z.literal("stopped"), cleanup: z.literal("stopped"), nativeDispatch: z.literal("deferred"), localDispatch: z.literal("deferred"), legacyWorkers: z.literal("stopped") }),
}).refine(value => value.stoppedAt <= value.writesDrainedAt && value.writesDrainedAt <= value.capturedAt && value.capturedAt <= value.verifiedAt, "Quiescence observations must be ordered");
export const quiescedExecutionSnapshotSchema = z.strictObject({
  version: z.literal(1), sourceEpoch: z.number().int().positive().max(2_147_483_646), fencedAt: timestamp, schema: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  accountId: z.literal("5359f28d385b8632c3abee12d1f5b011"), worker: fencedWorkerEvidenceSchema,
  migrationSha256: sha256, snapshotSha256: sha256, identitySha256: sha256, quiescenceSha256: sha256, quiescence: executionSnapshotQuiescenceSchema,
}).refine(value => value.quiescence.stoppedAt <= value.fencedAt && value.fencedAt <= value.quiescence.writesDrainedAt, "The execution fence must precede the verified write drain");
export type FencedWorkerEvidence = z.infer<typeof fencedWorkerEvidenceSchema>;
export type ExecutionSnapshotQuiescence = z.infer<typeof executionSnapshotQuiescenceSchema>;
export type QuiescedExecutionSnapshot = z.infer<typeof quiescedExecutionSnapshotSchema>;
