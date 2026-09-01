import type { GeneratedMediaReconciliation } from "./generated-media";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ParsedGeneratedMediaOperatorArgs =
  | { workspaceId: string; jobId: string; reconcile: false }
  | {
      workspaceId: string;
      jobId: string;
      reconcile: true;
      actorUserId: string;
      reason: GeneratedMediaOperatorReason;
      decision: GeneratedMediaReconciliation;
    };

const OPERATOR_REASONS = [
  "provider_dashboard_verified",
  "provider_support_verified",
  "billing_audit_verified",
  "storage_audit_verified",
] as const;
type GeneratedMediaOperatorReason = (typeof OPERATOR_REASONS)[number];
const TERMINAL_CODES = [
  "generated_media_provider_confirmed_failed",
  "generated_media_provider_confirmed_rejected",
  "generated_media_provider_confirmed_cancelled",
] as const;

export function parseGeneratedMediaOperatorArgs(args: string[]): ParsedGeneratedMediaOperatorArgs {
  let workspaceId: string | null = null;
  let jobId: string | null = null;
  let actorUserId: string | null = null;
  let reason: string | null = null;
  let decisionKind: GeneratedMediaReconciliation["kind"] | null = null;
  let providerRef: string | null = null;
  let code: string | null = null;
  let usageImages = 1;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = () => {
      index += 1;
      return args[index] ?? null;
    };
    if (argument === "--workspace") workspaceId = next();
    else if (argument === "--job") jobId = next();
    else if (argument === "--actor") actorUserId = next();
    else if (argument === "--reason") reason = next();
    else if (argument === "--decision") {
      const value = next();
      if (["retry", "completed", "failed", "rejected", "cancelled"].includes(value ?? "")) {
        decisionKind = value as GeneratedMediaReconciliation["kind"];
      } else {
        throw new Error("--decision must be retry, completed, failed, rejected, or cancelled");
      }
    } else if (argument === "--provider-ref") providerRef = next();
    else if (argument === "--code") code = next();
    else if (argument === "--usage-images") usageImages = Number(next());
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!workspaceId || !UUID.test(workspaceId)) throw new Error("--workspace must be a valid Workspace UUID");
  if (!jobId || !UUID.test(jobId)) throw new Error("--job must be a valid Generated Media Job UUID");
  if (!decisionKind) return { workspaceId, jobId, reconcile: false };
  if (!actorUserId || !UUID.test(actorUserId)) throw new Error("--actor must be a valid User UUID");
  const normalizedReason = reason?.trim() ?? "";
  if (!OPERATOR_REASONS.includes(normalizedReason as GeneratedMediaOperatorReason)) {
    throw new Error(`--reason must be one of: ${OPERATOR_REASONS.join(", ")}`);
  }

  let decision: GeneratedMediaReconciliation;
  if (decisionKind === "retry") decision = { kind: "retry" };
  else if (decisionKind === "completed") {
    if (!providerRef?.trim() || !/^[A-Za-z0-9._:-]{1,160}$/.test(providerRef.trim())) {
      throw new Error("--provider-ref must be a stable provider identifier");
    }
    if (!Number.isSafeInteger(usageImages) || usageImages < 1 || usageImages > 100) {
      throw new Error("--usage-images must be an integer from 1 to 100");
    }
    decision = { kind: "completed", providerRef: providerRef.trim(), usageImages };
  } else {
    const normalizedCode = code?.trim() ?? "";
    if (!TERMINAL_CODES.includes(normalizedCode as (typeof TERMINAL_CODES)[number])) {
      throw new Error(`--code must be one of: ${TERMINAL_CODES.join(", ")}`);
    }
    decision = { kind: decisionKind, code: normalizedCode };
  }
  return { workspaceId, jobId, reconcile: true, actorUserId, reason: normalizedReason as GeneratedMediaOperatorReason, decision };
}
