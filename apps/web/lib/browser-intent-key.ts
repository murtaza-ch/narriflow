type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type StoredIntentKey = {
  fingerprint: string;
  idempotencyKey: string;
};

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function opaqueFingerprint(intent: unknown) {
  const bytes = new TextEncoder().encode(canonicalJson(intent));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function storageKey(namespace: string) {
  return `narriflow:intent:v1:${namespace}`;
}

function parseStored(value: string | null): StoredIntentKey | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredIntentKey>;
    return typeof parsed.fingerprint === "string" &&
      typeof parsed.idempotencyKey === "string"
      ? {
          fingerprint: parsed.fingerprint,
          idempotencyKey: parsed.idempotencyKey,
        }
      : null;
  } catch {
    return null;
  }
}

export function createBrowserIntentKeyStore(dependencies: {
  storage: BrowserStorage;
  createId(): string;
}) {
  const memory = new Map<string, StoredIntentKey>();

  function read(namespace: string) {
    const key = storageKey(namespace);
    try {
      const stored = parseStored(dependencies.storage.getItem(key));
      if (stored) memory.set(key, stored);
      return stored ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  }

  function write(namespace: string, value: StoredIntentKey) {
    const key = storageKey(namespace);
    memory.set(key, value);
    try {
      dependencies.storage.setItem(key, JSON.stringify(value));
    } catch {
      // The in-memory record still protects retries within this page session.
    }
  }

  return {
    forIntent(namespace: string, intent: unknown) {
      const fingerprint = opaqueFingerprint(intent);
      const existing = read(namespace);
      if (existing?.fingerprint === fingerprint) return existing.idempotencyKey;
      const idempotencyKey = dependencies.createId();
      write(namespace, { fingerprint, idempotencyKey });
      return idempotencyKey;
    },

    confirm(namespace: string, intent: unknown) {
      const key = storageKey(namespace);
      const existing = read(namespace);
      if (existing?.fingerprint !== opaqueFingerprint(intent)) return;
      memory.delete(key);
      try {
        dependencies.storage.removeItem(key);
      } catch {
        // Nothing else can be cleared when browser storage is unavailable.
      }
    },
  };
}
