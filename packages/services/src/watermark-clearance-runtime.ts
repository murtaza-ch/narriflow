import type { PrismaClient } from "@prisma/client";
import { deliverExecutionDispatches, withExecutionDispatches } from "./execution-dispatch-runtime";
import { accessibleProjectWhere } from "./project-access";
import { requirePrisma } from "./require-prisma";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";

/** Production wiring for watermark clearance after an upgrade: one Project
 * per transaction, so one Project's failure never blocks the others. It runs
 * in its own dispatch scope: its render obligations never join the billing
 * request's delivery, and a scheduler failure here is logged, not raised. The
 * obligations are committed either way, and hourly dispatch recovery delivers
 * any that this attempt could not. */
export async function clearWorkspaceWatermarks(workspaceId: string, prisma: PrismaClient = requirePrisma()): Promise<void> {
  await withExecutionDispatches(() => clearEachProject(workspaceId, prisma), {
    independent: true,
    database: prisma,
    deliver: async (ids) => {
      try {
        await deliverExecutionDispatches(ids);
      } catch (error) {
        console.warn(JSON.stringify({ level: "warn", message: "watermark_clearance_dispatch_deferred", workspaceId, dispatchCount: ids.length,
          error: error instanceof Error ? error.message : String(error) }));
      }
    },
  });
}

async function clearEachProject(workspaceId: string, prisma: PrismaClient): Promise<void> {
  const projects = await prisma.project.findMany({
    where: {
      workspaceId, ingestStatus: "ready", sourceStorageKey: { not: null },
      // AND keeps the access rule's own OR (expiry) from being overwritten.
      AND: [
        accessibleProjectWhere(),
        { OR: [
          { clips: { some: { renders: { some: { exportVariantId: null, status: "completed", watermark: true } } } } },
          { clipExports: { some: { watermark: true } } },
        ] },
      ],
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const lifecycle = new WorkflowRunLifecycle({ prisma });
  for (const project of projects) {
    try {
      const result = await lifecycle.clearProjectWatermarks({ projectId: project.id, workspaceId });
      if (result.kind === "cleared" && result.renderIds.length) {
        console.warn(JSON.stringify({ level: "info", message: "watermark_clearance_reset", workspaceId, projectId: project.id,
          renderCount: result.renderIds.length, exportCount: result.exportIds.length }));
      }
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", message: "watermark_clearance_project_failed", workspaceId, projectId: project.id,
        error: error instanceof Error ? error.message : String(error) }));
    }
  }
}
