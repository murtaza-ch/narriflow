import { describe, expect, test } from "bun:test";
import { createPublicationIntentKeyStore } from "./publication-intent-key";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("publication intent browser key", () => {
  test("persists the key before a request and reuses it after a lost response", () => {
    const storage = memoryStorage();
    let ids = 0;
    const keys = createPublicationIntentKeyStore({
      storage,
      createId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    });
    const request = {
      projectId: "project-1",
      clipId: "clip-1",
      editorRevision: 7,
      accountId: "account-1",
      platform: "youtube_shorts",
      caption: "Approved caption",
      aspectRatio: "9:16",
      resolution: "1080p" as const,
      scheduledFor: "2026-08-29T10:00:00.000Z",
      providerSettings: {},
    };

    const first = keys.forRequest(request);
    expect(storage.getItem("narriflow:publication-intent:project-1")).toContain(
      first,
    );
    expect(keys.forRequest(request)).toBe(first);
    expect(ids).toBe(1);
  });

  test("mints another key after any immutable input changes", () => {
    const storage = memoryStorage();
    let ids = 0;
    const keys = createPublicationIntentKeyStore({
      storage,
      createId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    });
    const request = {
      projectId: "project-1",
      clipId: "clip-1",
      editorRevision: 7,
      accountId: "account-1",
      platform: "youtube_shorts",
      caption: "Approved caption",
      aspectRatio: "9:16",
      resolution: "1080p" as const,
      scheduledFor: "2026-08-29T10:00:00.000Z",
      providerSettings: {},
    };

    const first = keys.forRequest(request);
    const changed = keys.forRequest({ ...request, caption: "Final caption" });
    expect(changed).not.toBe(first);
    expect(ids).toBe(2);
  });

  test("forgets a confirmed request without exposing frozen media facts", () => {
    const storage = memoryStorage();
    const keys = createPublicationIntentKeyStore({
      storage,
      createId: () => "00000000-0000-4000-8000-000000000001",
    });
    const request = {
      projectId: "project-1",
      clipId: "clip-1",
      editorRevision: 7,
      accountId: "account-1",
      platform: "youtube_shorts",
      caption: "Approved caption",
      aspectRatio: "9:16",
      resolution: "1080p" as const,
      scheduledFor: "2026-08-29T10:00:00.000Z",
      providerSettings: {},
    };
    keys.forRequest(request);

    keys.confirm(request);

    expect(storage.getItem("narriflow:publication-intent:project-1")).toBeNull();
    expect(JSON.stringify(storage)).not.toContain("storageKey");
  });
});
