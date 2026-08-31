import { describe, expect, test } from "bun:test";

import { createBrowserIntentKeyStore } from "./browser-intent-key";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    snapshot: () => [...values.entries()],
  };
}

describe("browser intent keys", () => {
  test("reuses one persisted key after an ambiguous response without storing content", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const keys = createBrowserIntentKeyStore({
      storage,
      createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    });
    const intent = {
      projectId: "project-1",
      recipients: ["private-client@example.test"],
      passcode: "private-review-passcode",
      title: "Confidential launch",
    };

    const first = keys.forIntent("review:create:project-1", intent);

    expect(keys.forIntent("review:create:project-1", intent)).toBe(first);
    expect(sequence).toBe(1);
    const persisted = JSON.stringify(storage.snapshot());
    expect(persisted).toContain(first);
    expect(persisted).not.toContain("private-client@example.test");
    expect(persisted).not.toContain("private-review-passcode");
    expect(persisted).not.toContain("Confidential launch");
  });

  test("mints a new key when the canonical intent changes", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const keys = createBrowserIntentKeyStore({
      storage,
      createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    });
    const namespace = "assisted-copy:project-1:clip-1";
    const first = keys.forIntent(namespace, {
      campaignNote: "First launch",
      lockedTerms: ["Narriflow", "Studio"],
    });
    const reordered = keys.forIntent(namespace, {
      lockedTerms: ["Narriflow", "Studio"],
      campaignNote: "First launch",
    });
    const changed = keys.forIntent(namespace, {
      campaignNote: "Final launch",
      lockedTerms: ["Narriflow", "Studio"],
    });

    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
    expect(sequence).toBe(2);
  });

  test("clears only the matching confirmed intent", () => {
    const storage = memoryStorage();
    let sequence = 0;
    const keys = createBrowserIntentKeyStore({
      storage,
      createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    });
    const namespace = "thumbnail:project-1:variant-1";
    const original = { sourceTimeSec: 1, platform: "tiktok" };
    const changed = { sourceTimeSec: 2, platform: "tiktok" };

    keys.forIntent(namespace, original);
    keys.forIntent(namespace, changed);
    keys.confirm(namespace, original);
    expect(keys.forIntent(namespace, changed)).toBe(
      "00000000-0000-4000-8000-000000000002",
    );

    keys.confirm(namespace, changed);
    expect(keys.forIntent(namespace, changed)).toBe(
      "00000000-0000-4000-8000-000000000003",
    );
  });
});
