import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPORT_BUNDLE_CLEANUP_HOLD_MS,
  MediaCleanupClaimLost,
  adoptExportBundlePublication,
  admitExportBundleCleanup,
  exportBundleStorageKeys,
  planExportBundleCleanup,
  releaseExportBundleCleanup,
  renewExportBundleCleanup,
  retireExpiredExportBundle,
} from "@narriflow/services";
import { exportBundleManifestSchema, MAX_EXPORT_BUNDLE_INPUT_BYTES } from "@narriflow/validators";
import {
  createExportBundleArchive,
  expireExportBundles,
  runExportBundlePipeline,
} from "./export-bundle";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("export bundle archive", () => {
  test("keeps both staged and published objects scoped to one worker attempt", () => {
    const first = exportBundleStorageKeys("project-1", "operation-1", "attempt-1");
    const second = exportBundleStorageKeys("project-1", "operation-1", "attempt-2");
    expect(first).toEqual({
      attemptKey: "projects/project-1/campaign-operations/operation-1/attempts/attempt-1.zip",
      finalKey: "projects/project-1/campaign-operations/operation-1/completed/attempt-1.zip",
    });
    expect(first.finalKey).not.toBe(second.finalKey);
  });

  test("admits both attempt-scoped bundle objects behind a conservative producer hold", async () => {
    const now = new Date("2026-08-31T00:00:00.000Z");
    const plan = planExportBundleCleanup(
      "project-1",
      "operation-1",
      "attempt-1",
      now,
    );
    const captured: unknown[] = [];

    await admitExportBundleCleanup(
      {
        async createMany(input) {
          captured.push(input);
          return { count: input.data.length };
        },
      },
      plan,
    );

    expect(plan.claimExpiresAt).toEqual(
      new Date(now.getTime() + EXPORT_BUNDLE_CLEANUP_HOLD_MS),
    );
    expect(plan.obligations).toEqual([
      {
        origin: "export_bundle_attempt",
        cleanupClass: "export_bundle_attempt",
        projectId: "project-1",
        objectKey:
          "projects/project-1/campaign-operations/operation-1/attempts/attempt-1.zip",
      },
      {
        origin: "export_bundle_attempt",
        cleanupClass: "export_bundle_unsettled_publication",
        projectId: "project-1",
        objectKey:
          "projects/project-1/campaign-operations/operation-1/completed/attempt-1.zip",
      },
    ]);
    expect(captured).toEqual([
      {
        data: plan.obligations.map((obligation) => ({
          ...obligation,
          clipId: null,
          claimId: "attempt-1",
          claimExpiresAt: plan.claimExpiresAt,
        })),
        skipDuplicates: true,
      },
    ]);
  });

  test("renews both exact bundle obligations under the live producer claim", async () => {
    const admittedAt = new Date("2026-08-31T00:00:00.000Z");
    const renewedAt = new Date("2026-08-31T08:00:00.000Z");
    const plan = planExportBundleCleanup(
      "project-1",
      "operation-1",
      "attempt-1",
      admittedAt,
    );
    const updates: unknown[] = [];

    const renewedUntil = await renewExportBundleCleanup(
      {
        async updateMany(input) {
          updates.push(input);
          return { count: 2 };
        },
      },
      plan,
      renewedAt,
    );

    expect(renewedUntil).toEqual(
      new Date(renewedAt.getTime() + EXPORT_BUNDLE_CLEANUP_HOLD_MS),
    );
    expect(updates).toEqual([{
      where: {
        claimId: "attempt-1",
        claimExpiresAt: { gt: renewedAt },
        completedAt: null,
        attemptCount: 0,
        OR: plan.obligations.map(({ origin, cleanupClass, objectKey }) => ({
          origin,
          cleanupClass,
          objectKey,
        })),
      },
      data: {
        claimExpiresAt: renewedUntil,
        nextAttemptAt: renewedUntil,
      },
    }]);
  });

  test("rejects renewal when either exact bundle obligation is no longer held", async () => {
    const plan = planExportBundleCleanup(
      "project-1",
      "operation-1",
      "attempt-1",
      new Date("2026-08-31T00:00:00.000Z"),
    );

    await expect(renewExportBundleCleanup(
      {
        async updateMany() {
          return { count: 1 };
        },
      },
      plan,
      new Date("2026-08-31T08:00:00.000Z"),
    )).rejects.toBeInstanceOf(MediaCleanupClaimLost);
  });

  test("adopts only the exact final bundle object under the live workflow attempt", async () => {
    const plan = planExportBundleCleanup(
      "project-1",
      "operation-1",
      "attempt-1",
      new Date("2026-08-31T00:00:00.000Z"),
    );
    const updates: unknown[] = [];

    await adoptExportBundlePublication(
      {
        async updateMany(input) {
          updates.push(input);
          return {
            count: "completedAt" in input.data ? 1 : 2,
          };
        },
        async count() {
          return 0;
        },
      },
      plan,
      new Date("2026-08-31T00:01:00.000Z"),
    );

    expect(updates).toEqual([
      {
        where: {
          claimId: "attempt-1",
          claimExpiresAt: {
            gt: new Date("2026-08-31T00:01:00.000Z"),
          },
          completedAt: null,
          attemptCount: 0,
          OR: plan.obligations.map(({ origin, cleanupClass, objectKey }) => ({
            origin,
            cleanupClass,
            objectKey,
          })),
        },
        data: {
          claimExpiresAt: new Date("2026-09-01T00:01:00.000Z"),
          nextAttemptAt: new Date("2026-09-01T00:01:00.000Z"),
        },
      },
      expect.objectContaining({
        where: expect.objectContaining({
          claimId: "attempt-1",
          OR: [
            {
              origin: "export_bundle_attempt",
              cleanupClass: "export_bundle_unsettled_publication",
              objectKey:
                "projects/project-1/campaign-operations/operation-1/completed/attempt-1.zip",
            },
          ],
        }),
        data: expect.objectContaining({
          failureCode: "export_bundle_published",
        }),
      }),
    ]);
  });

  test("hands the exact attempt object to Media Cleanup without deleting it", async () => {
    const now = new Date("2026-08-31T00:02:00.000Z");
    const plan = planExportBundleCleanup(
      "project-1",
      "operation-1",
      "attempt-1",
      new Date("2026-08-31T00:00:00.000Z"),
    );
    const updates: unknown[] = [];

    await releaseExportBundleCleanup(
      {
        async updateMany(input) {
          updates.push(input);
          return { count: 1 };
        },
      },
      plan,
      [plan.obligations[0]],
      now,
    );

    expect(updates).toEqual([
      {
        where: {
          claimId: "attempt-1",
          completedAt: null,
          OR: [
            {
              origin: "export_bundle_attempt",
              cleanupClass: "export_bundle_attempt",
              objectKey:
                "projects/project-1/campaign-operations/operation-1/attempts/attempt-1.zip",
            },
          ],
        },
        data: {
          nextAttemptAt: now,
          claimId: null,
          claimExpiresAt: null,
          failureCode: "export_bundle_ready_for_cleanup",
        },
      },
    ]);
  });

  test("creates a real zip containing frozen names and a URL-free manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bundle-test-"));
    directories.push(directory);
    const clipId = crypto.randomUUID();
    const exportId = crypto.randomUUID();
    const variantId = crypto.randomUUID();
    const mediaPath = join(directory, "source.mp4");
    await Bun.write(mediaPath, new Uint8Array([0, 1, 2, 3, 4]));
    const manifest = {
      schemaVersion: 1 as const,
      operationId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
			included: [{ clipId, exportId, editorRevision: 4, files: [{ variantId, aspectRatio: "9:16" as const, name: "project/001-launch/9x16.mp4", sizeBytes: 5 }] }],
      excluded: [{ clipId: crypto.randomUUID(), code: "campaign_clip_stale" }],
    };
    const outputPath = join(directory, "bundle.zip");
		await createExportBundleArchive({ outputPath, manifest, files: [{ path: mediaPath, name: "project/001-launch/9x16.mp4" }] });
    const listing = await new Response(Bun.spawn(["unzip", "-Z1", outputPath]).stdout).text();
		expect(listing.trim().split("\n").sort()).toEqual(["manifest.json", "project/001-launch/9x16.mp4"]);
    const manifestText = await new Response(Bun.spawn(["unzip", "-p", outputPath, "manifest.json"]).stdout).text();
    expect(JSON.parse(manifestText)).toEqual(manifest);
    expect(manifestText).not.toContain("http");
		const extractedMedia = new Uint8Array(await new Response(Bun.spawn(["unzip", "-p", outputPath, "project/001-launch/9x16.mp4"]).stdout).arrayBuffer());
    expect(extractedMedia).toEqual(new Uint8Array([0, 1, 2, 3, 4]));
    const sourceChecksum = new Bun.CryptoHasher("sha256").update(new Uint8Array([0, 1, 2, 3, 4])).digest("hex");
    expect(new Bun.CryptoHasher("sha256").update(extractedMedia).digest("hex")).toBe(sourceChecksum);
    expect(() => exportBundleManifestSchema.parse({
      ...manifest,
      included: [{ ...manifest.included[0], files: [{ ...manifest.included[0]!.files[0], name: "../escape.mp4" }] }],
    })).toThrow();
    expect(() => exportBundleManifestSchema.parse({
      ...manifest,
      included: [{ ...manifest.included[0], files: [
        { ...manifest.included[0]!.files[0], sizeBytes: MAX_EXPORT_BUNDLE_INPUT_BYTES },
				{ ...manifest.included[0]!.files[0], variantId: crypto.randomUUID(), name: "project/001-launch/1x1.mp4", sizeBytes: 1 },
      ] }],
    })).toThrow("maximum aggregate input size");
  });

  test("contains failures at every mutable bundle stage without continuing", async () => {
    const stages = ["download", "archive", "upload", "publication", "settlement", "ownership"] as const;
    for (const failureStage of stages) {
      const calls: string[] = [];
      let ownershipChecks = 0;
      const fail = (stage: typeof failureStage) => {
        calls.push(stage);
        if (stage === failureStage) throw new Error(`injected_${stage}`);
      };
      const result = runExportBundlePipeline({
		entries: [{ variantId: crypto.randomUUID(), name: "project/001-clip/9x16.mp4", sizeBytes: 5 }],
        renewCleanup: async () => undefined,
        download: async () => {
          fail("download");
          return { path: "/tmp/clip.mp4", sizeBytes: 5 };
        },
        archive: async () => {
          fail("archive");
          return { path: "/tmp/bundle.zip" };
        },
        upload: async () => fail("upload"),
        assertOwnership: async () => {
          ownershipChecks += 1;
          calls.push(`ownership-${ownershipChecks}`);
          if (failureStage === "ownership" && ownershipChecks === 2) {
            throw new Error("injected_ownership");
          }
        },
        publish: async () => fail("publication"),
        settle: async () => fail("settlement"),
      });
      await expect(result).rejects.toThrow(`injected_${failureStage}`);
      if (failureStage !== "settlement") {
        expect(calls).not.toContain("settlement");
      }
    }
  });

  test("heartbeats both cleanup holds and renews immediately before upload, copy, and adoption", async () => {
    const events: string[] = [];
    let runHeartbeat: (() => Promise<void>) | null = null;
    let releaseDownload: (() => void) | null = null;
    let downloadStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    let renewal = 0;
    const processing = runExportBundlePipeline({
      entries: [{
        variantId: crypto.randomUUID(),
        name: "project/001-clip/9x16.mp4",
        sizeBytes: 5,
      }],
      heartbeatMs: 1_000,
      heartbeatScheduler: {
        start(callback, intervalMs) {
          expect(intervalMs).toBe(1_000);
          runHeartbeat = callback;
          return () => {
            events.push("heartbeat:stopped");
          };
        },
      },
      async renewCleanup() {
        renewal += 1;
        events.push(`renew:${renewal}`);
      },
      async download(_entry, _index, signal) {
        expect(signal.aborted).toBe(false);
        events.push("download:start");
        downloadStarted?.();
        await blocked;
        signal.throwIfAborted();
        events.push("download:end");
        return { path: "/tmp/clip.mp4", sizeBytes: 5 };
      },
      async archive(_files, signal) {
        signal.throwIfAborted();
        events.push("archive");
        return { path: "/tmp/bundle.zip" };
      },
      async upload(_archive, signal) {
        signal.throwIfAborted();
        events.push("upload");
      },
      async assertOwnership() {
        events.push("workflow:owned");
      },
      async publish(signal) {
        signal.throwIfAborted();
        events.push("copy");
      },
      async settle() {
        events.push("adopt");
      },
    });

    await started;
    await runHeartbeat?.();
    releaseDownload?.();
    await processing;

    expect(events).toEqual([
      "download:start",
      "renew:1",
      "download:end",
      "archive",
      "renew:2",
      "upload",
      "workflow:owned",
      "renew:3",
      "copy",
      "workflow:owned",
      "renew:4",
      "adopt",
      "heartbeat:stopped",
    ]);
  });

  test("aborts bundle processing when cleanup renewal loses either exact obligation", async () => {
    let runHeartbeat: (() => Promise<void>) | null = null;
    let downloadStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    const laterStages: string[] = [];
    const processing = runExportBundlePipeline({
      entries: [{
        variantId: crypto.randomUUID(),
        name: "project/001-clip/9x16.mp4",
        sizeBytes: 5,
      }],
      heartbeatScheduler: {
        start(callback) {
          runHeartbeat = callback;
          return () => undefined;
        },
      },
      async renewCleanup() {
        throw new Error("export_bundle_cleanup_claim_lost");
      },
      async download(_entry, _index, signal) {
        downloadStarted?.();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        signal.throwIfAborted();
        throw new Error("unreachable");
      },
      async archive() {
        laterStages.push("archive");
        return null;
      },
      async upload() {
        laterStages.push("upload");
      },
      async assertOwnership() {
        laterStages.push("ownership");
      },
      async publish() {
        laterStages.push("copy");
      },
      async settle() {
        laterStages.push("adopt");
      },
    });
    const outcome = processing.then(
      () => null,
      (error: unknown) => error,
    );

    await started;
    await runHeartbeat?.();

    expect(await outcome).toMatchObject({
      message: "export_bundle_cleanup_claim_lost",
    });
    expect(laterStages).toEqual([]);
  });

	test("downloads inputs sequentially before archiving to keep memory bounded", async () => {
		let activeDownloads = 0;
		let maximumActiveDownloads = 0;
		await runExportBundlePipeline({
			entries: Array.from({ length: 100 }, (_, index) => ({ variantId: crypto.randomUUID(), name: `project/${String(index + 1).padStart(3, "0")}-clip/9x16.mp4`, sizeBytes: 1 })),
			renewCleanup: async () => undefined,
			download: async (_entry, index) => {
				activeDownloads += 1;
				maximumActiveDownloads = Math.max(maximumActiveDownloads, activeDownloads);
				await Promise.resolve();
				activeDownloads -= 1;
				return { path: `/tmp/${index}.mp4`, sizeBytes: 1 };
			},
			archive: async (files) => files.length,
			upload: async () => undefined,
			assertOwnership: async () => undefined,
			publish: async () => undefined,
			settle: async () => undefined,
		});
		expect(maximumActiveDownloads).toBe(1);
	});

	test("expiry hands the exact published object to Media Cleanup without deleting it", async () => {
		const calls: string[] = [];
		const removed = await expireExportBundles(new Date("2026-08-31T00:00:00Z"), 10, {
			findExpired: async () => [{
				id: "bundle-1",
				projectId: "project-1",
				storageKey: "projects/project-1/campaign-operations/operation-1/completed/attempt-1.zip",
			}],
			retire: async (bundle, retiredAt) =>
				retireExpiredExportBundle(
					{
						mediaCleanupObligation: {
							async createMany(input) {
								calls.push(
									`admit:${input.data[0]?.objectKey}`,
								);
								return { count: input.data.length };
							},
						},
						exportBundle: {
							async updateMany(input) {
								calls.push(
									`retire:${input.where.id}:${input.where.storageKey}`,
								);
								return { count: 1 };
							},
						},
					},
					bundle,
					retiredAt,
				),
		});
		expect(removed).toBe(1);
		expect(calls).toEqual([
			"admit:projects/project-1/campaign-operations/operation-1/completed/attempt-1.zip",
			"retire:bundle-1:projects/project-1/campaign-operations/operation-1/completed/attempt-1.zip",
		]);
		expect(calls.some((call) => call.includes("clip-exports"))).toBe(false);
	});
});
