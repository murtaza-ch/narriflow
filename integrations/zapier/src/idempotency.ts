import { createHash } from 'node:crypto';
import type { PlainInputField } from 'zapier-platform-core';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined && entry !== null && entry !== '')
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/**
 * The optional input every action offers. Narriflow remembers an Idempotency-Key
 * for good, so a request made from the same inputs is the same request forever.
 * A Run Key that differs per trigger event lets the same inputs run once per event.
 */
export const RUN_KEY_FIELD: PlainInputField = {
  key: 'runKey',
  label: 'Run Key',
  helpText: "Map the trigger's Event ID so each event runs once.",
};

/**
 * The Idempotency-Key for one Zap step: `zapier:<action>:<sha256>`. The digest
 * covers the step's inputs, and with a Run Key the Run Key too. Zapier retries
 * and replays a step with the same inputs and Run Key, and the API answers every
 * repeat with the first result. Never add a random or time-based part: that would
 * turn each retry into a new request.
 */
export function idempotencyKey(action: string, inputs: Record<string, unknown>, runKey?: string): string {
  const key = runKey?.trim();
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical(key ? { runKey: key, inputs } : inputs)))
    .digest('hex');
  return `zapier:${action}:${digest}`;
}
