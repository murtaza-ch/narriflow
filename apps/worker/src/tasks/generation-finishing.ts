import { getGenerationFinishing } from "@narriflow/services";
import { notifyTerminalOutcome } from "../notifications";

/** Runs due finishing: exports the best clips and writes copy for generations
 * that asked for it. Failures are logged and retried by the row's own backoff,
 * so this loop never trips the worker's circuit breaker. */
export async function processDueGenerationFinishing(): Promise<number> {
  try {
    const handled = await getGenerationFinishing((input) => notifyTerminalOutcome({ ...input, outcome: "finishing_ready" })).processDue(
      Number(process.env.FINISHING_BATCH_SIZE ?? "3"),
    );
    if (handled > 0) {
      console.log(JSON.stringify({ level: "info", message: "generation_finishing_processed", ts: new Date().toISOString(), handled }));
    }
    return handled;
  } catch (error) {
    console.log(JSON.stringify({
      level: "error",
      message: "generation_finishing_failed",
      ts: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Unknown error",
    }));
    return 0;
  }
}
