import { assertCompletionCallbackUrl } from "./completion-callback";
import { callbackSigningSecrets } from "./completion-callback-runtime";
import { createDeveloperCommands } from "./developer-commands";
import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import { webhookSubscriptions } from "./webhook-subscription-runtime";
import { workspaceService } from "./workspace.service";

/** Production wiring of the developer commands. */
export const developerCommands = createDeveloperCommands({
  receipts: getOperationReceiptExecutor,
  workspaces: workspaceService,
  signingSecrets: callbackSigningSecrets,
  webhooks: webhookSubscriptions,
  assertCallbackUrl: (raw) => assertCompletionCallbackUrl(raw),
});
