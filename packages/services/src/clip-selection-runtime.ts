import { getPrismaClient } from "@narriflow/db/client";
import { readServiceEnvironment } from "./runtime-environment";
import { getWorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { getPerformanceGuidance } from "./performance-guidance-runtime";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { createClipSelectionPreparation } from "./clip-selection-preparation";
import { createClipSelectionLifecycle } from "./clip-selection-window";
import { createClipSelectionControl } from "./clip-selection-control";
import { createClipSelectionProvider } from "./clip-selection-provider";
import { createClipSelectionStorage } from "./clip-selection-storage";

/** A required positive-integer setting; a missing one names itself instead of becoming NaN. */
function requiredLimit(settings: Record<string, string | undefined>, name: string) {
  const value = Number(settings[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be set to a positive integer`);
  return value;
}

/** Fresh invocation services. No provider key, database client or capsule crosses a sleep. */
export function getClipSelectionControl() {
  const database = getPrismaClient();
  if (!database) throw new Error("Selection requires a database scope");
  const settings = readServiceEnvironment();
  const storage = createClipSelectionStorage({ accountId: settings.R2_ACCOUNT_ID ?? "", bucket: settings.R2_BUCKET ?? "", accessKeyId: settings.R2_ACCESS_KEY_ID ?? "", secretAccessKey: settings.R2_SECRET_ACCESS_KEY ?? "" });
  const configuredOutputTokens = Number(settings.OPENAI_CLIP_MAX_OUTPUT_TOKENS);
  // These are the original detector settings. Request/token concurrency caps
  // below are required explicit configuration and have no default.
  const provider = { model: settings.OPENAI_CLIP_MODEL ?? "gpt-5.4-mini", reasoningEffort: "medium", maxOutputTokens: Number.isFinite(configuredOutputTokens) && configuredOutputTokens > 0 ? Math.round(configuredOutputTokens) : 32000 };
  return createClipSelectionControl({ preparation: createClipSelectionPreparation({ database, storage, provider, guidance: getPerformanceGuidance() }),
    lifecycle: createClipSelectionLifecycle({ database, maxInFlightRequests: requiredLimit(settings, "OPENAI_SELECTION_MAX_IN_FLIGHT_REQUESTS"), maxEstimatedTokens: requiredLimit(settings, "OPENAI_SELECTION_MAX_ESTIMATED_TOKENS") }),
    finalization: getWorkflowRunLifecycle(), storage, deliver: deliverExecutionDispatches,
    provider: { generate: input => createClipSelectionProvider({ ...input.configuration, apiKey: settings.OPENAI_API_KEY ?? "" }).generate(input) },
    observeProvider: input => console.warn(JSON.stringify({ level: "info", message: "clip_selection_provider_limits", ...input })),
  });
}
