import { autopilotService } from "@narriflow/services";

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      level,
      message,
      ts: new Date().toISOString(),
      ...context,
    }),
  );
}

export async function processDueAutopilotRules() {
  try {
    const result = await autopilotService.processDueRules(
      Number(process.env.AUTOPILOT_BATCH_SIZE ?? "3"),
    );
    if (result.checked > 0 || result.imported > 0) {
      log("info", "autopilot_rules_processed", result);
    }
    return result.checked;
  } catch (error) {
    log("error", "autopilot_processing_failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return 0;
  }
}
