const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 300_000;

export function parseWorkspaceBillingPollInterval(value: string | undefined) {
  const parsed = value === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(value);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < MIN_POLL_INTERVAL_MS ||
    parsed > MAX_POLL_INTERVAL_MS
  ) {
    throw new Error(
      `WORKSPACE_BILLING_POLL_INTERVAL_MS must be a finite integer between ${MIN_POLL_INTERVAL_MS} and ${MAX_POLL_INTERVAL_MS}`,
    );
  }
  return parsed;
}
