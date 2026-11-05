import { afterEach, expect, test } from "bun:test";
import { identifyAnalytics, isUntrackedPath, resetAnalytics, scrubAnalyticsEvent, track } from "./analytics";

const calls: unknown[][] = [];
afterEach(() => { calls.length = 0; delete (globalThis as { window?: unknown }).window; });
function install() {
  (globalThis as { window?: unknown }).window = { narriflowAnalytics: {
    capture: (...args: unknown[]) => calls.push(["capture", ...args]),
    identify: (...args: unknown[]) => calls.push(["identify", ...args]),
    reset: () => calls.push(["reset"]),
  } };
}

test("tracking is silent during server rendering and on untracked pages", () => {
  expect(() => track("checkout_start", { target_tier: "pro", billing_interval: "month" })).not.toThrow();
  (globalThis as { window?: unknown }).window = {};
  expect(() => { track("import_submit", { source: "link" }); identifyAnalytics("user"); resetAnalytics(); }).not.toThrow();
});

test("events and identity reach the installed client", () => {
  install();
  track("upgrade_prompt_view", { target_tier: "pro" });
  identifyAnalytics("user_clerk");
  resetAnalytics();
  expect(calls).toEqual([["capture", "upgrade_prompt_view", { target_tier: "pro" }], ["identify", "user_clerk"], ["reset"]]);
});

test("pages whose URL grants access never load analytics", () => {
  for (const path of ["/review/abc", "/share/abc", "/invite/abc"]) expect(isUntrackedPath(path)).toBe(true);
  for (const path of ["/", "/reviews", "/shared", "/home", "/invitations"]) expect(isUntrackedPath(path)).toBe(false);
});

test("capability tokens and query strings never leave in a URL property", () => {
  const event = scrubAnalyticsEvent({
    event: "$pageview",
    properties: {
      $current_url: "https://app.test/home?__clerk_handshake=secret#frag",
      $referrer: "https://app.test/invite/invitetoken?x=1",
      $pathname: "/share/sharetoken",
      utm_source: "newsletter",
      count: 2,
      $web_vitals_FCP_event: { navigationURL: "https://app.test/?secret=1", attribution: [{ url: "https://app.test/share/sharetoken?x=1" }] },
    },
    $set_once: { $initial_current_url: "https://app.test/?redirect_url=/review/reviewtoken" },
  });
  expect(event.properties).toEqual({
    $current_url: "https://app.test/home",
    $referrer: "https://app.test/invite/[token]",
    $pathname: "/share/[token]",
    utm_source: "newsletter",
    count: 2,
    $web_vitals_FCP_event: { navigationURL: "https://app.test/", attribution: [{ url: "https://app.test/share/[token]" }] },
  });
  expect(event.$set_once).toEqual({ $initial_current_url: "https://app.test/" });
  expect(scrubAnalyticsEvent(null)).toBeNull();
});
