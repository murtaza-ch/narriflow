import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";

/** Dependencies of the Zoom webhook adapter. The automation owner replaces this with the Zoom service. */
export type AutomationWebhookDeps = Record<string, never>;

/** Zoom event delivery (`POST /api/webhooks/zoom`): signature-authenticated, outside the first-party chain. */
export function createAutomationWebhookRoutes(_deps: AutomationWebhookDeps) {
  return new Hono<ApiEnv>();
}

export type AutomationWebhookRoutes = ReturnType<typeof createAutomationWebhookRoutes>;
