import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBundleManifestSchema, MAX_EXPORT_BUNDLE_INPUT_BYTES } from "@narriflow/validators";
import { createExportBundleArchive, expireExportBundles, exportBundleStorageKeys, runExportBundlePipeline } from "./export-bundle";

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

	test("downloads inputs sequentially before archiving to keep memory bounded", async () => {
		let activeDownloads = 0;
		let maximumActiveDownloads = 0;
		await runExportBundlePipeline({
			entries: Array.from({ length: 100 }, (_, index) => ({ variantId: crypto.randomUUID(), name: `project/${String(index + 1).padStart(3, "0")}-clip/9x16.mp4`, sizeBytes: 1 })),
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

	test("expiry deletes only the published bundle object and then clears its row", async () => {
		const calls: string[] = [];
		const removed = await expireExportBundles(new Date("2026-08-31T00:00:00Z"), 10, {
			findExpired: async () => [{ id: "bundle-1", storageKey: "projects/project-1/campaign-operations/operation-1/completed/attempt-1.zip" }],
			removeObject: async (storageKey) => { calls.push(`delete:${storageKey}`); },
			markExpired: async ({ id, storageKey }) => { calls.push(`expire:${id}:${storageKey}`); return 1; },
		});
		expect(removed).toBe(1);
		expect(calls).toEqual([
			"delete:projects/project-1/campaign-operations/operation-1/completed/attempt-1.zip",
			"expire:bundle-1:projects/project-1/campaign-operations/operation-1/completed/attempt-1.zip",
		]);
		expect(calls.some((call) => call.includes("clip-exports"))).toBe(false);
	});
});
