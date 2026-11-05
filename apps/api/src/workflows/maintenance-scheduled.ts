import { createDatabaseScope, type DatabaseScope, withDatabaseScope } from "@narriflow/db/client";
import type { createExecutionMaintenanceRuntime } from "@narriflow/services/execution-maintenance-runtime";
import { withExecutionDispatches } from "@narriflow/services/execution-dispatch-runtime";
import { logFailure } from "@narriflow/services/log-failure";
import type { ApiWorkerBindings } from "../worker-bindings";
import { withWorkerServices, workerServiceEnvironment } from "../worker-services";

type MaintenanceRuntime = Pick<Awaited<ReturnType<typeof createExecutionMaintenanceRuntime>>, "scheduled">;
interface ScheduledDependencies {
  createRuntime(): Promise<MaintenanceRuntime>;
  /** Hourly, after registration is confirmed, so a failed run sends no healthy ping. */
  checkHealth?(): Promise<void>;
  /** Hourly even after a failed run, because each window is read only once. */
  forwardEvents?(scheduledAt: Date): Promise<void>;
  createScope?(connectionString: string): DatabaseScope;
}

/** Cron only registers the first bounded metadata page. The Workflow owns all
 * later pages, and each invocation closes its database scope before returning. */
export function createMaintenanceScheduledHandler(dependencies: ScheduledDependencies) {
  return async (controller: ScheduledController, bindings: ApiWorkerBindings, _context: ExecutionContext): Promise<void> => {
    if (bindings.ADMISSION_STATE === "fenced") return;
    const admissionState = bindings.ADMISSION_STATE;
    if (admissionState !== "open" && admissionState !== "closed") throw Error("maintenance_admission_configuration_invalid");
    const cadence = controller.cron === "0 * * * *" ? "hourly" : controller.cron === "0 0 * * *" ? "daily" : null;
    if (!cadence || !Number.isSafeInteger(controller.scheduledTime)) throw Error("maintenance_schedule_invalid");
    const scheduledAt = new Date(controller.scheduledTime);
    if (!Number.isFinite(scheduledAt.getTime())) throw Error("maintenance_schedule_invalid");
    await withWorkerServices(bindings, workerServiceEnvironment(bindings), () => withDatabaseScope(
      (dependencies.createScope ?? (connectionString => createDatabaseScope({ connectionString })))(bindings.HYPERDRIVE.connectionString),
      async () => {
        const hourly = cadence === "hourly";
        try {
          await withExecutionDispatches(async () => { await (await dependencies.createRuntime()).scheduled({ cadence, scheduledAt, admissionState }); });
          if (hourly) await dependencies.checkHealth?.();
        } catch (error) {
          logFailure("maintenance_cron_failed", error, { kind: cadence });
          throw error;
        } finally {
          if (hourly) await dependencies.forwardEvents?.(scheduledAt);
        }
      },
    ));
  };
}
