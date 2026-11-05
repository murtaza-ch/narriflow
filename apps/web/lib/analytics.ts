/** Installed by instrumentation-client.ts. The SDK loads only there, so pages never
 * import it, and tracking is silent on review pages or without a project token. */
export interface AnalyticsClient {
  capture(event: string, properties: Record<string, string>): void;
  identify(distinctId: string): void;
  reset(): void;
}
declare global {
  interface Window { narriflowAnalytics?: AnalyticsClient }
}
const client = () => (typeof window === "undefined" ? undefined : window.narriflowAnalytics);

/** Their URLs grant access, and their visitors are outside recipients who never signed up. */
const CAPABILITY_ROUTE = /\/(review|share|invite)\/[^/?#]+/;
export const isUntrackedPath = (pathname: string) => /^\/(review|share|invite)(\/|$)/.test(pathname);

const scrubLink = (value: string) => value.replace(CAPABILITY_ROUTE, "/$1/[token]").replace(/[?#].*$/, "");
/** Recursive, because PostHog copies the page URL into nested objects such as web vitals. */
function scrubLinks(value: unknown): unknown {
  if (typeof value === "string") return /^(https?:\/\/|\/)/.test(value) ? scrubLink(value) : value;
  if (Array.isArray(value)) return value.map(scrubLinks);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubLinks(item)]));
  return value;
}

/** Query strings hold Clerk handshakes and redirects, and a referrer can hold an invite
 * link. Campaign data survives, because PostHog copies UTM values into their own properties. */
export function scrubAnalyticsEvent<Event extends { properties?: unknown; $set?: unknown; $set_once?: unknown } | null>(event: Event): Event {
  if (!event) return event;
  const scrubbed = { ...event };
  for (const section of ["properties", "$set", "$set_once"] as const) if (event[section]) scrubbed[section] = scrubLinks(event[section]);
  return scrubbed;
}

/** Intent only: what a person tried. What happened is recorded by the server, so
 * it survives ad blockers. docs/tracking-plan.md is the catalog. Never send text a
 * person typed, such as a title, a caption or a link. */
interface ClientEvents {
  import_submit: { source: "link" | "drive" | "rss" | "file" };
  upgrade_prompt_view: { target_tier: string };
  checkout_start: { target_tier: string; billing_interval: string };
}

export function track<Name extends keyof ClientEvents>(event: Name, properties: ClientEvents[Name]) {
  client()?.capture(event, { ...properties });
}
export function identifyAnalytics(distinctId: string) { client()?.identify(distinctId); }
export function resetAnalytics() { client()?.reset(); }
