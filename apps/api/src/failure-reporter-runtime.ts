import { waitUntil } from "cloudflare:workers";
import { installFailureReporter } from "@narriflow/services/log-failure";
import type { ProductEvent } from "@narriflow/services/product-events";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { PostHog } from "posthog-node";
import { createFailureReporter } from "./failure-reporter";

const POSTHOG_HOST = "https://us.i.posthog.com";

function settings() {
  try {
    const environment = readServiceEnvironment();
    return { token: environment.POSTHOG_PROJECT_TOKEN, deployment: environment.DEPLOYMENT_VERSION };
  } catch { return null; }
}

/** Hourly, so one client sends the whole batch and closes. */
export async function sendProductEvents(events: ProductEvent[]) {
  const token = settings()?.token;
  if (!token) return;
  const client = new PostHog(token, { host: POSTHOG_HOST, flushAt: 100, flushInterval: 0, disableGeoip: true });
  for (const { uuid, event, distinctId, timestamp, properties } of events) client.capture({ uuid, event, distinctId, timestamp, properties });
  await client.shutdown();
}

/** Workers can stop before a batch leaves, so each failure sends at once. */
export function installWorkerFailureReporter() {
  installFailureReporter(createFailureReporter({ settings, waitUntil,
    createClient: token => new PostHog(token, { host: POSTHOG_HOST, flushAt: 1, flushInterval: 0 }) }));
}
