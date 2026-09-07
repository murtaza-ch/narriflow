import type {
  BillingHealth,
  BillingInterval,
  PaidPricingTier,
} from "@narriflow/validators";

interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface MutableBrowserStorage extends BrowserStorage {
  removeItem(key: string): void;
}

function checkoutStorageKey(input: {
  workspaceId: string;
  tier: PaidPricingTier;
  interval: BillingInterval;
}) {
  return [
    "narriflow.checkout.v1",
    input.workspaceId,
    input.tier,
    input.interval,
  ].join(":");
}

export function getOrCreateCheckoutKey(input: {
  storage: BrowserStorage;
  workspaceId: string;
  tier: PaidPricingTier;
  interval: BillingInterval;
  createKey: () => string;
}) {
  const storageKey = checkoutStorageKey(input);
  const existing = input.storage.getItem(storageKey);
  if (existing) return existing;
  const created = input.createKey();
  input.storage.setItem(storageKey, created);
  return created;
}

export function clearCheckoutKey(input: {
  storage: MutableBrowserStorage;
  workspaceId: string;
  tier: PaidPricingTier;
  interval: BillingInterval;
}) {
  input.storage.removeItem(checkoutStorageKey(input));
}

export async function pollBillingActivation<TView extends { health: BillingHealth }>(
  input: {
    read: () => Promise<{ view: TView; retryAfterSeconds?: number }>;
    wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
    maxAttempts?: number;
    signal?: AbortSignal;
  },
): Promise<{ view: TView; retryAfterSeconds?: number }> {
  const maxAttempts = input.maxAttempts ?? 12;
  let lastResult: { view: TView; retryAfterSeconds?: number } | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const result = await input.read();
      lastResult = result;
      if (result.view.health !== "activating" && result.view.health !== "retrying") {
        return result;
      }
      const baseMs = Math.max(1, result.retryAfterSeconds ?? 2) * 1_000;
      const jitteredMs = Math.round(baseMs * (1 + (input.random?.() ?? Math.random()) * 0.2));
      await input.wait(jitteredMs, input.signal);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      await input.wait(2_000, input.signal);
    }
  }
  if (lastResult) return lastResult;
  throw new Error("Billing activation could not be checked");
}

export function waitForBillingPoll(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
