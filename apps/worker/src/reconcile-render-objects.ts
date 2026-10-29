import { createProductionRenderObjectReconciler } from "./render-object-reconciler";

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main() {
  const projectId = argumentValue("--project");
  if (!projectId) {
    throw new Error(
      "Usage: bun run reconcile:render-objects --project <uuid> [--delete]",
    );
  }

  const result = await createProductionRenderObjectReconciler().execute({
    projectId,
    delete: process.argv.includes("--delete"),
  });
  console.warn(
    JSON.stringify({
      level: result.failed > 0 ? "warn" : "info",
      message: "render_orphan_reconciliation_result",
      projectId,
      ...result,
    }),
  );

  if (result.failed > 0) process.exitCode = 2;
  else if (result.orphaned > result.deleted) process.exitCode = 1;
}

/** Periodic inventory is dry-run until its evidence has been reviewed. */
export async function reconcileRenderObjectsForMaintenance(projectId: string, signal: AbortSignal): Promise<void> {
  await createProductionRenderObjectReconciler().execute({
    projectId, signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    delete: false, maxPagesPerPrefix: 1,
  });
}

if (import.meta.main) {
try {
  await main();
} catch (error) {
  console.warn(
    JSON.stringify({
      level: "error",
      message: "render_orphan_reconciliation_unavailable",
      errorCode: error instanceof Error ? error.name : "reconciliation_failed",
      errorMessage: error instanceof Error ? error.message : "unknown",
    }),
  );
  process.exitCode = 3;
}

}
