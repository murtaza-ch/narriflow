import { describe, expect, test } from "bun:test";
import {
  DurableMediaCopyClaimLost,
  adoptDurableMediaCopies,
  admitMediaCleanupObligations,
  admitRetiredClipMediaCleanup,
  planRetiredClipMediaCleanup,
  runDurableMediaCopies,
  type MediaCleanupAdmissionStore,
} from "./media-cleanup";

describe("Media Cleanup", () => {
  test("admission deduplicates work and can hold provisional compensation", async () => {
    const captured: Parameters<MediaCleanupAdmissionStore["createMany"]>[0][] = [];
    const store: MediaCleanupAdmissionStore = {
      async createMany(input) {
        captured.push(input);
        return { count: input.data.length };
      },
    };
    const obligation = {
      origin: "clip_duplicate_compensation" as const,
      cleanupClass: "mutable_render" as const,
      projectId: "project-1",
      clipId: "clip-copy",
      objectKey: "private/copy.mp4",
    };
    const claimExpiresAt = new Date("2026-08-29T00:15:00.000Z");

    expect(
      await admitMediaCleanupObligations(store, [obligation, obligation], {
        heldClaim: { claimId: "compensation-claim", claimExpiresAt },
      }),
    ).toBe(1);
    expect(captured).toEqual([
      {
        data: [
          {
            ...obligation,
            claimId: "compensation-claim",
            claimExpiresAt,
          },
        ],
        skipDuplicates: true,
      },
    ]);
  });

  test("retired Clip planning covers renders, preview, peaks, and dub media", () => {
    const obligations = planRetiredClipMediaCleanup(
      "detected_clip_replacement",
      "project-1",
      [
        {
          clipId: "clip-1",
          previewStorageKey: "private/preview.mp4",
          renderStorageKeys: ["private/render.mp4", null],
          dubStorageKeys: ["private/dub-audio.mp3", "private/dub-video.mp4"],
        },
      ],
    );

    expect(
      obligations.map(({ cleanupClass, objectKey }) => [cleanupClass, objectKey]),
    ).toEqual([
      ["mutable_render", "private/render.mp4"],
      ["dub_media", "private/dub-audio.mp3"],
      ["dub_media", "private/dub-video.mp4"],
      ["preview_proxy", "private/preview.mp4"],
      ["preview_peaks", "private/preview.peaks.json"],
    ]);
  });

  test("detected replacement admits no work for empty results or Clips without media", async () => {
    let admissionCalls = 0;
    const store = {
      clip: {
        findMany: async () => [
          {
            id: "clip-empty",
            previewStorageKey: null,
            renders: [{ storageKey: null }],
            dubs: [{ audioStorageKey: null, renderStorageKey: null }],
          },
        ],
      },
      mediaCleanupObligation: {
        async createMany() {
          admissionCalls += 1;
          return { count: 0 };
        },
      },
    };

    expect(
      await admitRetiredClipMediaCleanup(
        store,
        "detected_clip_replacement",
        "project-1",
      ),
    ).toBe(0);
    expect(admissionCalls).toBe(0);

    store.clip.findMany = async () => [];
    expect(
      await admitRetiredClipMediaCleanup(
        store,
        "detected_clip_replacement",
        "project-1",
      ),
    ).toBe(0);
    expect(admissionCalls).toBe(0);
  });

  test("detected replacement deduplicates mixed keys and replayed admission", async () => {
    const admitted = new Set<string>();
    const store = {
      clip: {
        findMany: async () => [
          {
            id: "clip-1",
            previewStorageKey: "private/preview.mp4",
            renders: [
              { storageKey: null },
              { storageKey: "private/render.mp4" },
              { storageKey: "private/render.mp4" },
            ],
            dubs: [],
          },
        ],
      },
      mediaCleanupObligation: {
        async createMany(input: {
          data: Array<{
            origin: string;
            cleanupClass: string;
            objectKey: string;
          }>;
        }) {
          let count = 0;
          for (const item of input.data) {
            const key = `${item.origin}:${item.cleanupClass}:${item.objectKey}`;
            if (admitted.has(key)) continue;
            admitted.add(key);
            count += 1;
          }
          return { count };
        },
      },
    };

    expect(
      await admitRetiredClipMediaCleanup(
        store,
        "detected_clip_replacement",
        "project-1",
      ),
    ).toBe(3);
    expect(
      await admitRetiredClipMediaCleanup(
        store,
        "detected_clip_replacement",
        "project-1",
      ),
    ).toBe(0);
    expect(admitted.size).toBe(3);
  });

  test("detected replacement surfaces admission failure to its transaction owner", async () => {
    const store = {
      clip: {
        findMany: async () => [
          {
            id: "clip-1",
            previewStorageKey: null,
            renders: [{ storageKey: "private/render.mp4" }],
            dubs: [],
          },
        ],
      },
      mediaCleanupObligation: {
        async createMany() {
          throw new Error("injected cleanup admission failure");
        },
      },
    };

    await expect(
      admitRetiredClipMediaCleanup(
        store,
        "detected_clip_replacement",
        "project-1",
      ),
    ).rejects.toThrow("injected cleanup admission failure");
  });

  test("failed duplicate adoption releases every copied or ambiguous destination", async () => {
    const obligations = new Map<
      string,
      { claimId?: string; claimExpiresAt?: Date; released?: boolean }
    >();
    const store: MediaCleanupAdmissionStore = {
      async createMany(input) {
        for (const item of input.data) obligations.set(item.objectKey, item);
        return { count: input.data.length };
      },
    };
    const plans = ["copy-success.mp4", "copy-ambiguous.mp4"].map(
      (objectKey) => ({
        origin: "clip_duplicate_compensation" as const,
        cleanupClass: "mutable_render" as const,
        projectId: "project-1",
        clipId: "clip-copy",
        sourceKey: `source/${objectKey}`,
        objectKey: `destination/${objectKey}`,
        value: objectKey,
      }),
    );
    const adoptionOutcomes: string[] = [];
    const compensationOutcomes: string[] = [];

    await expect(
      runDurableMediaCopies({
        store,
        plans,
        claimId: "compensation-claim",
        claimExpiresAt: new Date("2026-08-29T00:15:00.000Z"),
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        now: () => new Date("2026-08-29T00:00:00.000Z"),
        renew: async () => true,
        async copy(plan) {
          if (plan.value === "copy-ambiguous.mp4") {
            throw new Error("copy response lost");
          }
        },
        async adopt(copied) {
          expect(copied.map((plan) => plan.value)).toEqual([
            "copy-success.mp4",
          ]);
          throw new Error("database unavailable");
        },
        async release(objectKeys, claimId) {
          for (const objectKey of objectKeys) {
            const obligation = obligations.get(objectKey);
            expect(obligation?.claimId).toBe(claimId);
            obligations.set(objectKey, { ...obligation, released: true });
          }
          return objectKeys.length;
        },
        onAdoptionOutcome(outcome, context) {
          adoptionOutcomes.push(
            `${outcome}:${context.copiedObjectCount}/${context.plannedObjectCount}`,
          );
        },
        onCompensationOutcome(outcome, context) {
          compensationOutcomes.push(
            `${outcome}:${context.releasedObjectCount}`,
          );
        },
      }),
    ).rejects.toThrow("database unavailable");
    expect([...obligations.values()]).toHaveLength(2);
    expect([...obligations.values()].every((item) => item.released)).toBe(true);
    expect(adoptionOutcomes).toEqual(["failed:1/2"]);
    expect(compensationOutcomes).toEqual(["released:2"]);
  });

  test("a provisional admission conflict prevents any remote copy", async () => {
    let copyCalls = 0;
    const store: MediaCleanupAdmissionStore = {
      async createMany() {
        return { count: 0 };
      },
    };

    await expect(
      runDurableMediaCopies({
        store,
        plans: [
          {
            origin: "clip_duplicate_compensation",
            cleanupClass: "mutable_render",
            projectId: "project-1",
            clipId: "clip-copy",
            sourceKey: "source/render.mp4",
            objectKey: "destination/render.mp4",
            value: null,
          },
        ],
        claimId: "compensation-claim",
        claimExpiresAt: new Date("2026-08-29T00:15:00.000Z"),
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        now: () => new Date("2026-08-29T00:00:00.000Z"),
        renew: async () => false,
        async copy() {
          copyCalls += 1;
        },
        async adopt() {
          return undefined;
        },
        async release() {
          return 0;
        },
      }),
    ).rejects.toThrow("media_copy_compensation_admission_conflict");
    expect(copyCalls).toBe(0);
  });

  test("a stable same-claim retry resumes after idempotent admission", async () => {
    let renewCalls = 0;
    let copyCalls = 0;
    const result = await runDurableMediaCopies({
      store: { createMany: async () => ({ count: 0 }) },
      plans: [
        {
          origin: "clip_duplicate_compensation",
          cleanupClass: "mutable_render",
          projectId: "project-1",
          clipId: "clip-copy",
          sourceKey: "source/render.mp4",
          objectKey: "destination/render.mp4",
          value: null,
        },
      ],
      claimId: "stable-claim",
      claimExpiresAt: new Date("2026-08-29T00:15:00.000Z"),
      leaseMs: 60_000,
      heartbeatMs: 20_000,
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      renew: async () => {
        renewCalls += 1;
        return true;
      },
      copy: async () => {
        copyCalls += 1;
      },
      adopt: async () => "adopted",
      release: async () => 0,
    });

    expect(result).toBe("adopted");
    expect(renewCalls).toBe(2);
    expect(copyCalls).toBe(1);
  });

  test("zero-copy success adopts an empty set and leaves no compensation", async () => {
    let adoptCalls = 0;
    let releaseCalls = 0;
    const result = await runDurableMediaCopies({
      store: { createMany: async () => ({ count: 0 }) },
      plans: [],
      claimId: "empty-claim",
      claimExpiresAt: new Date("2026-08-29T00:15:00.000Z"),
      leaseMs: 60_000,
      heartbeatMs: 20_000,
      renew: async () => true,
      copy: async () => undefined,
      async adopt(copied) {
        adoptCalls += 1;
        expect(copied).toEqual([]);
        return "created-without-media";
      },
      async release() {
        releaseCalls += 1;
        return 0;
      },
    });

    expect(result).toBe("created-without-media");
    expect(adoptCalls).toBe(1);
    expect(releaseCalls).toBe(0);
  });

  test("claim takeover during a copy prevents adoption", async () => {
    let heartbeat: (() => Promise<void>) | null = null;
    let adoptCalls = 0;
    const store: MediaCleanupAdmissionStore = {
      async createMany(input) {
        return { count: input.data.length };
      },
    };

    await expect(
      runDurableMediaCopies({
        store,
        plans: [
          {
            origin: "clip_duplicate_compensation",
            cleanupClass: "mutable_render",
            projectId: "project-1",
            clipId: "clip-copy",
            sourceKey: "source/render.mp4",
            objectKey: "destination/render.mp4",
            value: null,
          },
        ],
        claimId: "lost-claim",
        claimExpiresAt: new Date("2026-08-29T00:01:00.000Z"),
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        now: () => new Date("2026-08-29T00:00:00.000Z"),
        heartbeatScheduler: {
          start(callback) {
            heartbeat = callback;
            return () => undefined;
          },
        },
        renew: async () => false,
        async copy() {
          await heartbeat?.();
        },
        async adopt() {
          adoptCalls += 1;
          return undefined;
        },
        async release() {
          return 0;
        },
      }),
    ).rejects.toBeInstanceOf(DurableMediaCopyClaimLost);
    expect(adoptCalls).toBe(0);
  });

  test("fenced adoption rejects a stale or partially owned obligation set", async () => {
    await expect(
      adoptDurableMediaCopies(
        {
          async updateMany() {
            return { count: 1 };
          },
          async count() {
            return 0;
          },
        },
        [
          {
            origin: "clip_duplicate_compensation",
            cleanupClass: "mutable_render",
            projectId: "project-1",
            clipId: "clip-copy",
            sourceKey: "source/render.mp4",
            objectKey: "destination/render.mp4",
            value: null,
          },
          {
            origin: "clip_duplicate_compensation",
            cleanupClass: "preview_proxy",
            projectId: "project-1",
            clipId: "clip-copy",
            sourceKey: "source/preview.mp4",
            objectKey: "destination/preview.mp4",
            value: null,
          },
        ],
        "stale-claim",
        new Date("2026-08-29T00:00:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(DurableMediaCopyClaimLost);
  });

  test("adoption settlement is idempotent after the first committed removal", async () => {
    let calls = 0;
    const plan = {
      origin: "clip_duplicate_compensation" as const,
      cleanupClass: "mutable_render" as const,
      projectId: "project-1",
      clipId: "clip-copy",
      sourceKey: "source/render.mp4",
      objectKey: "destination/render.mp4",
      value: null,
    };
    const store = {
      async updateMany() {
        calls += 1;
        return { count: calls === 1 ? 1 : 0 };
      },
      async count(input: { where: { failureCode: string } }) {
        expect(input.where.failureCode).toBe("duplicate_media_adopted");
        return 1;
      },
    };

    await expect(
      adoptDurableMediaCopies(
        store,
        [plan],
        "stable-claim",
        new Date("2026-08-29T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      adoptDurableMediaCopies(
        store,
        [plan],
        "stable-claim",
        new Date("2026-08-29T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
  });

  test("a cleanup-completed obligation cannot satisfy adoption replay", async () => {
    await expect(
      adoptDurableMediaCopies(
        {
          async updateMany() {
            return { count: 0 };
          },
          async count(input) {
            expect(input.where.failureCode).toBe("duplicate_media_adopted");
            return 0;
          },
        },
        [
          {
            origin: "clip_duplicate_compensation",
            cleanupClass: "mutable_render",
            projectId: "project-1",
            clipId: "clip-copy",
            sourceKey: "source/render.mp4",
            objectKey: "destination/render.mp4",
            value: null,
          },
        ],
        "stale-claim",
        new Date("2026-08-29T00:00:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(DurableMediaCopyClaimLost);
  });

  test("successful duplicate adoption retires copied obligations and releases only failed copies", async () => {
    const active = new Set<string>();
    const released: string[] = [];
    const store: MediaCleanupAdmissionStore = {
      async createMany(input) {
        for (const item of input.data) active.add(item.objectKey);
        return { count: input.data.length };
      },
    };
    const plans = ["adopted.mp4", "failed.mp4"].map((name) => ({
      origin: "clip_duplicate_compensation" as const,
      cleanupClass: "mutable_render" as const,
      projectId: "project-1",
      clipId: "clip-copy",
      sourceKey: `source/${name}`,
      objectKey: `destination/${name}`,
      value: name,
    }));
    const adoptionOutcomes: string[] = [];
    const compensationOutcomes: string[] = [];

    const result = await runDurableMediaCopies({
      store,
      plans,
      claimId: "compensation-claim",
      claimExpiresAt: new Date("2026-08-29T00:15:00.000Z"),
      leaseMs: 60_000,
      heartbeatMs: 20_000,
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      renew: async () => true,
      async copy(plan) {
        if (plan.value === "failed.mp4") throw new Error("copy failed");
      },
      async adopt(copied) {
        for (const plan of copied) active.delete(plan.objectKey);
        return "clip-created";
      },
      async release(objectKeys) {
        released.push(...objectKeys);
        return objectKeys.length;
      },
      onAdoptionOutcome(outcome) {
        adoptionOutcomes.push(outcome);
      },
      onCompensationOutcome(outcome) {
        compensationOutcomes.push(outcome);
      },
    });

    expect(result).toBe("clip-created");
    expect(active).toEqual(new Set(["destination/failed.mp4"]));
    expect(released).toEqual(["destination/failed.mp4"]);
    expect(adoptionOutcomes).toEqual(["succeeded"]);
    expect(compensationOutcomes).toEqual(["released"]);
  });

  test("a short compensation settlement reports release failure", async () => {
    const outcomes: string[] = [];
    let releaseFailures = 0;
    await expect(
      runDurableMediaCopies({
        store: { createMany: async (input) => ({ count: input.data.length }) },
        plans: [
          {
            origin: "clip_duplicate_compensation",
            cleanupClass: "mutable_render",
            projectId: "project-1",
            clipId: "clip-copy",
            sourceKey: "source/render.mp4",
            objectKey: "destination/render.mp4",
            value: null,
          },
        ],
        claimId: "lost-release-claim",
        claimExpiresAt: new Date("2026-08-29T00:15:00.000Z"),
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        renew: async () => true,
        copy: async () => {
          throw new Error("ambiguous copy");
        },
        adopt: async () => "clip-created",
        release: async () => 0,
        onReleaseFailure() {
          releaseFailures += 1;
        },
        onCompensationOutcome(outcome, context) {
          outcomes.push(`${outcome}:${context.releasedObjectCount}`);
        },
      }),
    ).resolves.toBe("clip-created");
    expect(releaseFailures).toBe(1);
    expect(outcomes).toEqual(["release_failed:0"]);
  });

});
