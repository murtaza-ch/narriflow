import { canonicalJson } from "./keys";
import type { ApiScope } from "./scope";

export interface IntentKeyOptions {
  /** Defaults to `crypto.randomUUID`; supply one on runtimes without it. */
  randomUUID?: () => string;
  /** When given, a key is also dropped if the user or Workspace changed since it was minted. */
  scope?: ApiScope;
}

/**
 * One user intent (a form submission, a button press that creates something).
 * `keyFor(input)` returns the same key for the same input until `complete()`,
 * so a retry after a timeout, lost response or token refresh replays the
 * original command instead of creating a second one. A changed input, a new
 * user/Workspace, or `complete()` starts a new intent.
 *
 *   const intent = createIntent<CreateFolder>({ scope });
 *   mutationFn: (input) => api.create(input, intent.keyFor(input)),
 *   onSuccess: () => intent.complete(),
 *
 * Call `complete()` on confirmed success only; keep the key through network,
 * timeout and 5xx failures. Keys are never persisted.
 */
export interface Intent<TInput> {
  keyFor(input: TInput): string;
  complete(): void;
}

function defaultRandomUUID(): string {
  const generate = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (!generate) throw new Error("crypto.randomUUID is required to mint idempotency keys");
  return generate();
}

export function createIntent<TInput>(options: IntentKeyOptions = {}): Intent<TInput> {
  const randomUUID = options.randomUUID ?? defaultRandomUUID;
  let current: { key: string; fingerprint: string; scopeVersion: number | null } | null = null;
  return {
    keyFor(input) {
      const fingerprint = canonicalJson(input);
      const scopeVersion = options.scope ? options.scope.snapshot().version : null;
      if (
        current &&
        current.fingerprint === fingerprint &&
        current.scopeVersion === scopeVersion
      ) {
        return current.key;
      }
      current = { key: randomUUID(), fingerprint, scopeVersion };
      return current.key;
    },
    complete() {
      current = null;
    },
  };
}
