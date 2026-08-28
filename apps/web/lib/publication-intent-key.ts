type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type PublicationIntentRequest = {
  projectId: string;
  clipId: string;
  editorRevision: number;
  accountId: string | null;
  platform: string;
  caption: string;
  aspectRatio: string;
  resolution: "720p" | "1080p";
  scheduledFor: string;
  providerSettings: Record<string, unknown>;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function storageKey(projectId: string) {
  return `narriflow:publication-intent:${projectId}`;
}

function readRecord(storage: BrowserStorage, projectId: string) {
  const raw = storage.getItem(storageKey(projectId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { fingerprint?: unknown; key?: unknown };
    return typeof parsed.fingerprint === "string" && typeof parsed.key === "string"
      ? { fingerprint: parsed.fingerprint, key: parsed.key }
      : null;
  } catch {
    return null;
  }
}

export function createPublicationIntentKeyStore(dependencies: {
  storage: BrowserStorage;
  createId(): string;
}) {
  return {
    forRequest(request: PublicationIntentRequest) {
      const fingerprint = canonicalJson(request);
      const existing = readRecord(dependencies.storage, request.projectId);
      if (existing?.fingerprint === fingerprint) return existing.key;
      const key = dependencies.createId();
      dependencies.storage.setItem(
        storageKey(request.projectId),
        JSON.stringify({ fingerprint, key }),
      );
      return key;
    },

    confirm(request: PublicationIntentRequest) {
      const fingerprint = canonicalJson(request);
      const existing = readRecord(dependencies.storage, request.projectId);
      if (existing?.fingerprint === fingerprint) {
        dependencies.storage.removeItem(storageKey(request.projectId));
      }
    },
  };
}
