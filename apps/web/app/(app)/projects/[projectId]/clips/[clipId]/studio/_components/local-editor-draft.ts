import {
  editorDocumentSchema,
  editorDocumentsEqual,
  type EditorDocument,
} from "@narriflow/validators";

const DATABASE_NAME = "narriflow-studio";
const DATABASE_VERSION = 1;
const DRAFT_STORE_NAME = "editor-drafts";

export const LOCAL_DRAFT_WRITE_DEBOUNCE_MS = 100;
export const EDITOR_LEASE_TTL_MS = 8_000;
export const EDITOR_LEASE_HEARTBEAT_MS = 2_500;

export interface StoredEditorDraft {
  formatVersion: 2;
  key: string;
  projectId: string;
  clipId: string;
  baseRevision: number;
  baseDocument: EditorDocument;
  document: EditorDocument;
  updatedAt: number;
  writerId: string;
  ownershipGeneration: number;
}

export interface EditorLease {
  ownerId: string;
  expiresAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type DraftRecovery =
  | { kind: "none" }
  | { kind: "recover"; document: EditorDocument; baseRevision: number; merged: boolean }
  | { kind: "conflict"; document: EditorDocument; paths: string[] };

export function editorDraftKey(projectId: string, clipId: string): string {
  return `${projectId}:${clipId}`;
}

export function editorLeaseKey(projectId: string, clipId: string): string {
  return `narriflow:studio-lease:${editorDraftKey(projectId, clipId)}`;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface MergeResult {
  value: unknown;
  conflicts: string[];
}

/**
 * Conservative three-way JSON merge. Arrays are atomic because transcript,
 * cue and layer arrays are ordered domain values: combining two independently
 * edited arrays by index can silently attach edits to the wrong item. Plain
 * objects merge recursively, so unrelated style/settings changes recover
 * automatically while overlapping edits are surfaced to the user.
 */
function mergeValue(base: unknown, local: unknown, remote: unknown, path: string): MergeResult {
  if (jsonEqual(local, remote)) return { value: local, conflicts: [] };
  if (jsonEqual(local, base)) return { value: remote, conflicts: [] };
  if (jsonEqual(remote, base)) return { value: local, conflicts: [] };

  if (isPlainObject(base) && isPlainObject(local) && isPlainObject(remote)) {
    const value: Record<string, unknown> = {};
    const conflicts: string[] = [];
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const child = mergeValue(
        base[key],
        local[key],
        remote[key],
        path ? `${path}.${key}` : key,
      );
      value[key] = child.value;
      conflicts.push(...child.conflicts);
    }
    return { value, conflicts };
  }

  return { value: local, conflicts: [path || "document"] };
}

export function mergeEditorDocuments(
  base: EditorDocument,
  local: EditorDocument,
  remote: EditorDocument,
): { document: EditorDocument; conflicts: string[] } {
  const merged = mergeValue(base, local, remote, "");
  const parsed = editorDocumentSchema.safeParse(merged.value);
  if (!parsed.success) {
    return { document: local, conflicts: [...merged.conflicts, "document.invalid"] };
  }
  return { document: parsed.data, conflicts: [...new Set(merged.conflicts)] };
}

export function decideDraftRecovery(
  draft: StoredEditorDraft | null,
  serverDocument: EditorDocument,
  serverRevision: number,
): DraftRecovery {
  if (!draft || editorDocumentsEqual(draft.document, serverDocument)) {
    return { kind: "none" };
  }

  if (draft.baseRevision === serverRevision) {
    return {
      kind: "recover",
      document: draft.document,
      baseRevision: serverRevision,
      merged: false,
    };
  }

  if (draft.baseRevision < serverRevision) {
    const merged = mergeEditorDocuments(
      draft.baseDocument,
      draft.document,
      serverDocument,
    );
    if (merged.conflicts.length === 0) {
      return {
        kind: "recover",
        document: merged.document,
        baseRevision: serverRevision,
        merged: true,
      };
    }
    return { kind: "conflict", document: draft.document, paths: merged.conflicts };
  }

  // A local base revision ahead of the server is not expected, but can
  // happen after restoring browser storage against a rolled-back database.
  // Preserve the draft and require an explicit choice rather than guessing.
  return { kind: "conflict", document: draft.document, paths: ["revision"] };
}

export function parseStoredEditorDraft(value: unknown): StoredEditorDraft | null {
  if (!isPlainObject(value)) return null;
  const projectId = value.projectId;
  const clipId = value.clipId;
  const key = value.key;
  const baseRevision = value.baseRevision;
  const updatedAt = value.updatedAt;
  const writerId = value.writerId;
  const formatVersion = value.formatVersion;
  const ownershipGeneration = value.ownershipGeneration;
  const baseDocument = editorDocumentSchema.safeParse(value.baseDocument);
  const document = editorDocumentSchema.safeParse(value.document);
  if (
    typeof projectId !== "string" ||
    typeof clipId !== "string" ||
    typeof key !== "string" ||
    typeof baseRevision !== "number" ||
    !Number.isInteger(baseRevision) ||
    baseRevision < 0 ||
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt) ||
    typeof writerId !== "string" ||
    formatVersion !== 2 ||
    typeof ownershipGeneration !== "number" ||
    !Number.isInteger(ownershipGeneration) ||
    ownershipGeneration < 0 ||
    key !== editorDraftKey(projectId, clipId) ||
    !baseDocument.success ||
    !document.success
  ) {
    return null;
  }
  return {
    formatVersion,
    key,
    projectId,
    clipId,
    baseRevision,
    updatedAt,
    writerId,
    ownershipGeneration,
    baseDocument: baseDocument.data,
    document: document.data,
  };
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDraftDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        database.createObjectStore(DRAFT_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("Could not open the local draft database"));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("The local draft database upgrade was blocked"));
    };
  });
  return databasePromise;
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Draft transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Draft transaction failed"));
  });
}

export async function loadEditorDraft(
  projectId: string,
  clipId: string,
): Promise<StoredEditorDraft | null> {
  const database = await openDraftDatabase();
  const transaction = database.transaction(DRAFT_STORE_NAME, "readonly");
  const request = transaction.objectStore(DRAFT_STORE_NAME).get(editorDraftKey(projectId, clipId));
  const raw = await new Promise<unknown>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not load the local draft"));
  });
  await waitForTransaction(transaction);
  return parseStoredEditorDraft(raw);
}

export async function persistEditorDraft(
  draft: StoredEditorDraft,
): Promise<"written" | "stale"> {
  const database = await openDraftDatabase();
  const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
  const store = transaction.objectStore(DRAFT_STORE_NAME);
  const request = store.get(draft.key);
  const raw = await new Promise<unknown>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not fence local draft"));
  });
  const current = raw === undefined ? null : parseStoredEditorDraft(raw);
  if (raw !== undefined && !current) {
    throw new Error("The existing local draft is unreadable");
  }
  if (current && current.ownershipGeneration > draft.ownershipGeneration) {
    await waitForTransaction(transaction);
    return "stale";
  }
  store.put(draft);
  await waitForTransaction(transaction);
  return "written";
}

export async function removeEditorDraft(
  projectId: string,
  clipId: string,
  ownershipGeneration?: number,
): Promise<"removed" | "stale"> {
  const database = await openDraftDatabase();
  const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
  const store = transaction.objectStore(DRAFT_STORE_NAME);
  const key = editorDraftKey(projectId, clipId);
  if (ownershipGeneration !== undefined) {
    const request = store.get(key);
    const raw = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not fence draft removal"));
    });
    const current = raw === undefined ? null : parseStoredEditorDraft(raw);
    if (raw !== undefined && !current) {
      throw new Error("The existing local draft is unreadable");
    }
    if (current && current.ownershipGeneration > ownershipGeneration) {
      await waitForTransaction(transaction);
      return "stale";
    }
  }
  store.delete(key);
  await waitForTransaction(transaction);
  return "removed";
}

export function readEditorLease(storage: StorageLike, key: string): EditorLease | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isPlainObject(parsed) ||
      typeof parsed.ownerId !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      return null;
    }
    return { ownerId: parsed.ownerId, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export function claimEditorLease(
  storage: StorageLike,
  key: string,
  ownerId: string,
  now: number,
  force = false,
): boolean {
  try {
    const current = readEditorLease(storage, key);
    if (!force && current && current.ownerId !== ownerId && current.expiresAt > now) {
      return false;
    }
    storage.setItem(
      key,
      JSON.stringify({ ownerId, expiresAt: now + EDITOR_LEASE_TTL_MS } satisfies EditorLease),
    );
    return readEditorLease(storage, key)?.ownerId === ownerId;
  } catch {
    // localStorage can be disabled or full. Server revisions still protect
    // correctness, so fail open for availability and let 409 stop a race.
    return true;
  }
}

export function renewEditorLease(
  storage: StorageLike,
  key: string,
  ownerId: string,
  now: number,
): boolean {
  const current = readEditorLease(storage, key);
  if (!current || current.ownerId !== ownerId) return false;
  return claimEditorLease(storage, key, ownerId, now, true);
}

export function releaseEditorLease(storage: StorageLike, key: string, ownerId: string): void {
  try {
    if (readEditorLease(storage, key)?.ownerId === ownerId) storage.removeItem(key);
  } catch {
    // Best-effort cleanup; the short TTL makes abandoned leases recoverable.
  }
}

export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, Math.min(attempt, 5)));
}
