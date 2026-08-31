import { describe, expect, test } from "bun:test";

import {
  assistedCopyIntentIsSettled,
  createPublishingPreparationBrowserIntents,
} from "./publishing-preparation-browser-intents";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("publishing-preparation browser intents", () => {
  test("retains the key while a replayed copy request is still generating", () => {
    expect(assistedCopyIntentIsSettled("generating")).toBe(false);
    expect(assistedCopyIntentIsSettled("completed")).toBe(true);
    expect(assistedCopyIntentIsSettled("rejected")).toBe(true);
    expect(assistedCopyIntentIsSettled("failed")).toBe(true);
    expect(assistedCopyIntentIsSettled("unknown")).toBe(true);
  });

  test("replays ambiguous copy generation and advances after confirmed success", () => {
    let sequence = 0;
    const intents = createPublishingPreparationBrowserIntents({
      storage: memoryStorage(),
      createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    });
    const request = {
      clipId: "clip-1",
      platform: "tiktok",
      campaignNote: "Launch",
      lockedTerms: ["Narriflow"],
      sourceDraftId: null,
    };

    const first = intents.assistedCopy("project-1", "clip-1", request);
    expect(
      intents.assistedCopy("project-1", "clip-1", request).idempotencyKey,
    ).toBe(first.idempotencyKey);
    first.confirm();
    expect(
      intents.assistedCopy("project-1", "clip-1", request).idempotencyKey,
    ).not.toBe(first.idempotencyKey);
  });

  test("keeps an exact-frame job key until the extraction intent changes", () => {
    let sequence = 0;
    const intents = createPublishingPreparationBrowserIntents({
      storage: memoryStorage(),
      createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    });
    const request = {
      platform: "tiktok",
      exportVariantId: "variant-1",
      sourceTimeSec: 1,
      title: "Campaign clip thumbnail",
    };

    const first = intents.thumbnail("project-1", "variant-1", request);
    expect(
      intents.thumbnail("project-1", "variant-1", request).idempotencyKey,
    ).toBe(first.idempotencyKey);
    expect(
      intents.thumbnail("project-1", "variant-1", {
        ...request,
        sourceTimeSec: 2,
      }).idempotencyKey,
    ).not.toBe(first.idempotencyKey);
  });
});
