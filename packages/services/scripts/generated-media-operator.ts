import { parseGeneratedMediaOperatorArgs } from "../src/generated-media-operator";
import { generatedMediaService } from "../src/generated-media.service";

function write(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const input = parseGeneratedMediaOperatorArgs(process.argv.slice(2));
  const before = await generatedMediaService.inspectForOperator(input.workspaceId, input.jobId);
  if (!input.reconcile) {
    write({ mode: "inspect", inspection: before });
  } else {
    const result = await generatedMediaService.reconcileForOperator(
      input.workspaceId,
      input.jobId,
      input.decision,
    );
    console.warn(JSON.stringify({
      level: "warn",
      message: "generated_media_operator_reconciled",
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      decision: input.decision.kind,
    }));
    write({ mode: "reconcile", before, result });
  }
} catch (error) {
  write({
    mode: "failed",
    error: error instanceof Error && "code" in error ? String(error.code) : "generated_media_operator_failed",
  });
  process.exitCode = 1;
}
