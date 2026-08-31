import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import { createPrismaGeneratedMediaStudioLibrary } from "./generated-media-studio.prisma";
import { GeneratedMediaStudioError } from "./generated-media-studio";

const ids = {
	actor: "00000000-0000-4000-8000-000000000001",
	workspace: "00000000-0000-4000-8000-000000000002",
	project: "00000000-0000-4000-8000-000000000003",
	clip: "00000000-0000-4000-8000-000000000004",
	asset: "00000000-0000-4000-8000-000000000005",
	placement: "00000000-0000-4000-8000-000000000006",
};

const scope = {
	actorUserId: ids.actor,
	workspaceId: ids.workspace,
	workspaceOwnerUserId: ids.actor,
	role: "owner" as const,
	status: "active" as const,
	pricingTier: "free",
	isPersonalWorkspace: false,
};

const request = {
	scope,
	projectId: ids.project,
	clipId: ids.clip,
	assetId: ids.asset,
	fingerprint: "a".repeat(64),
	mediaKind: "image" as const,
};

function fakePrisma(options: {
	clip?: unknown;
	asset?: unknown;
	onClipWhere?: (where: unknown) => void;
	onAssetWhere?: (where: unknown) => void;
}) {
	return {
		clip: {
			findFirst: async ({ where }: { where: unknown }) => {
				options.onClipWhere?.(where);
				return options.clip;
			},
		},
		visualAsset: {
			findFirst: async ({ where }: { where: unknown }) => {
				options.onAssetWhere?.(where);
				return options.asset;
			},
		},
	} as unknown as PrismaClient;
}

const exactClip = {
	brollPlacements: [
		{
			id: ids.placement,
			asset: {
				kind: "visual_asset",
				id: ids.asset,
				fingerprint: request.fingerprint,
			},
			provenance: "generated",
			mediaKind: "image",
			startSec: 2,
			endSec: 5,
			sourceStartSec: null,
			sourceEndSec: null,
		},
	],
};

describe("Prisma generated-media Studio library", () => {
	test("signs an exact generated result as an attachment", async () => {
		let jobWhere: unknown;
		let signedInput: { key: string; fileName?: string } | null = null;
		const prisma = {
			generatedMediaJob: {
				findFirst: async ({ where }: { where: unknown }) => {
					jobWhere = where;
					return {
						ownerUserId: null,
						ownerWorkspaceId: ids.workspace,
						stagedFingerprint: request.fingerprint,
						resultAssetId: ids.asset,
						resultAsset: {
							id: ids.asset,
							userId: null,
							workspaceId: ids.workspace,
							title: "Quiet morning",
							kind: "image",
							contentType: "image/png",
							storageKey: "generated-media/private.png",
							fingerprint: request.fingerprint,
							provenance: "generated",
							deletedAt: null,
						},
					};
				},
			},
		} as unknown as PrismaClient;
		const library = createPrismaGeneratedMediaStudioLibrary(prisma, {
			resolve: async (key, fileName) => {
				signedInput = { key, fileName };
				return {
					state: "available" as const,
					accessUrl: "https://signed.example.test/attachment.png",
				};
			},
		});

		await expect(library.resolveJobDownload({
			scope,
			projectId: ids.project,
			jobId: "77777777-7777-4777-8777-777777777777",
			resultAssetId: ids.asset,
			kind: "image",
		})).resolves.toEqual({
			accessUrl: "https://signed.example.test/attachment.png",
		});
		expect(jobWhere).toMatchObject({
			workspaceId: ids.workspace,
			projectId: ids.project,
			resultAssetId: ids.asset,
		});
		expect(signedInput).toEqual({
			key: "generated-media/private.png",
			fileName: "Quiet morning.png",
		});
	});

	test("projects an uploaded fingerprint collision but excludes an extracted collision", async () => {
		const jobIds = [
			"00000000-0000-4000-8000-000000000101",
			"00000000-0000-4000-8000-000000000102",
		];
		const result = (jobId: string, provenance: "uploaded" | "extracted") => ({
			id: jobId,
			ownerUserId: null,
			ownerWorkspaceId: ids.workspace,
			stagedFingerprint: request.fingerprint,
			resultAssetId: ids.asset,
			resultAsset: {
				id: ids.asset,
				userId: null,
				workspaceId: ids.workspace,
				title: "Quiet morning",
				kind: "image",
				fingerprint: request.fingerprint,
				provenance,
				durationSec: null,
				storageKey: `${provenance}/quiet.png`,
				deletedAt: null,
				profiles: [],
			},
		});
		const prisma = {
			generatedMediaJob: {
				findMany: async () => [
					result(jobIds[0]!, "uploaded"),
					result(jobIds[1]!, "extracted"),
				],
			},
		} as unknown as PrismaClient;
		const library = createPrismaGeneratedMediaStudioLibrary(prisma, {
			resolve: async (key) => ({
				state: "available" as const,
				accessUrl: `https://signed.example.test/${key}`,
			}),
		});

		await expect(library.resolveJobAssets({
			scope,
			projectId: ids.project,
			activeBrandProfileId: null,
			jobs: jobIds.map((jobId) => ({
				jobId,
				resultAssetId: ids.asset,
				kind: "image" as const,
			})),
		})).resolves.toEqual([
			expect.objectContaining({
				jobId: jobIds[0],
				state: "available",
				asset: expect.objectContaining({ provenance: "uploaded" }),
			}),
			{
				jobId: jobIds[1],
				state: "missing",
				savedToActiveBrandProfile: false,
				asset: null,
			},
		]);
	});

	test("downloads an uploaded collision and rejects extracted or stale result identity", async () => {
		let provenance: "uploaded" | "extracted" = "uploaded";
		let fingerprint = request.fingerprint;
		let objectReads = 0;
		const prisma = {
			generatedMediaJob: {
				findFirst: async () => ({
					ownerUserId: null,
					ownerWorkspaceId: ids.workspace,
					stagedFingerprint: request.fingerprint,
					resultAssetId: ids.asset,
					resultAsset: {
						id: ids.asset,
						userId: null,
						workspaceId: ids.workspace,
						title: "Original upload",
						kind: "image",
						contentType: "image/png",
						storageKey: "uploads/original.png",
						fingerprint,
						provenance,
						deletedAt: null,
					},
				}),
			},
		} as unknown as PrismaClient;
		const library = createPrismaGeneratedMediaStudioLibrary(prisma, {
			resolve: async () => {
				objectReads += 1;
				return {
					state: "available" as const,
					accessUrl: "https://signed.example.test/original.png",
				};
			},
		});
		const input = {
			scope,
			projectId: ids.project,
			jobId: "77777777-7777-4777-8777-777777777777",
			resultAssetId: ids.asset,
			kind: "image" as const,
		};

		await expect(library.resolveJobDownload(input)).resolves.toEqual({
			accessUrl: "https://signed.example.test/original.png",
		});
		provenance = "extracted";
		await expect(library.resolveJobDownload(input)).resolves.toBeNull();
		provenance = "uploaded";
		fingerprint = "b".repeat(64);
		await expect(library.resolveJobDownload(input)).resolves.toBeNull();
		expect(objectReads).toBe(1);
	});

	test("resolves exact tenant Clip words and rejects nonexistent client source ids", async () => {
		const library = createPrismaGeneratedMediaStudioLibrary(fakePrisma({
			clip: {
				editorRevision: 8,
				transcriptSlice: [{
					index: 4,
					speaker: null,
					speakerLabel: "Speaker",
					startSec: 10,
					endSec: 11,
					text: "Quiet morning",
					confidence: 0.9,
					words: [
						{ word: "Quiet", startSec: 10, endSec: 10.4, confidence: 0.9 },
						{ word: "morning", startSec: 10.5, endSec: 11, confidence: 0.9 },
					],
				}],
				brollCues: [],
			},
			asset: null,
		}));
		const base = {
			scope,
			projectId: ids.project,
			clipId: ids.clip,
			sourceRevision: 8,
			includeDerivedContext: true,
			promptOrigin: {
				kind: "transcript_selection" as const,
				sourceIds: [
					`clip:${ids.clip}:transcript:4:0`,
					`clip:${ids.clip}:transcript:4:1`,
				],
			},
		};
		await expect(library.resolvePromptContext(base)).resolves.toBe("Quiet morning");
		await expect(library.resolvePromptContext({
			...base,
			promptOrigin: {
				...base.promptOrigin,
				sourceIds: [`clip:${ids.clip}:transcript:4:99`],
			},
		})).rejects.toMatchObject({ code: "generated_media_prompt_source_invalid" });

		const stale = createPrismaGeneratedMediaStudioLibrary(fakePrisma({
			clip: {
				editorRevision: 9,
				transcriptSlice: [{
					index: 4,
					speaker: null,
					speakerLabel: "Speaker",
					startSec: 10,
					endSec: 11,
					text: "Changed morning",
					confidence: 0.9,
					words: [
						{ word: "Changed", startSec: 10, endSec: 10.4, confidence: 0.9 },
						{ word: "morning", startSec: 10.5, endSec: 11, confidence: 0.9 },
					],
				}],
				brollCues: [],
			},
			asset: null,
		}));
		await expect(stale.resolvePromptContext(base)).rejects.toMatchObject({
			code: "generated_media_prompt_source_revision_conflict",
		});
	});

	test("soft-deletes a generated asset while frozen Clip references retain it", async () => {
		let updates = 0;
		const tx = {
			generatedMediaJob: {
				findFirst: async () => ({
					ownerUserId: null,
					ownerWorkspaceId: ids.workspace,
					stagedFingerprint: request.fingerprint,
					resultAssetId: ids.asset,
					resultAsset: {
						id: ids.asset,
						userId: null,
						workspaceId: ids.workspace,
						fingerprint: request.fingerprint,
						provenance: "generated",
						deletedAt: null,
						profiles: [],
						sceneTemplates: [],
						socialPostThumbnails: [],
					},
				}),
			},
			visualAsset: {
				updateMany: async () => {
					updates += 1;
					return { count: 1 };
				},
			},
			$queryRaw: async () => {
				throw new Error("Clip document references must not block soft delete");
			},
		};
		const prisma = {
			$transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
				operation(tx),
		} as unknown as PrismaClient;
		const library = createPrismaGeneratedMediaStudioLibrary(prisma);

		await expect(
			library.softDeleteUnreferenced({
				scope,
				projectId: ids.project,
				jobId: "77777777-7777-4777-8777-777777777777",
			}),
		).resolves.toEqual({ assetId: ids.asset, deleted: true });
		expect(updates).toBe(1);
	});

	test("never soft-deletes an uploaded asset reused by a generated job", async () => {
		let updates = 0;
		const tx = {
			generatedMediaJob: {
				findFirst: async () => ({
					ownerUserId: null,
					ownerWorkspaceId: ids.workspace,
					stagedFingerprint: request.fingerprint,
					resultAssetId: ids.asset,
					resultAsset: {
						id: ids.asset,
						userId: null,
						workspaceId: ids.workspace,
						fingerprint: request.fingerprint,
						provenance: "uploaded",
						deletedAt: null,
						profiles: [],
						sceneTemplates: [],
						socialPostThumbnails: [],
					},
				}),
			},
			visualAsset: {
				updateMany: async () => {
					updates += 1;
					return { count: 1 };
				},
			},
		};
		const prisma = {
			$transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
				operation(tx),
		} as unknown as PrismaClient;
		const library = createPrismaGeneratedMediaStudioLibrary(prisma);

		await expect(library.softDeleteUnreferenced({
			scope,
			projectId: ids.project,
			jobId: "77777777-7777-4777-8777-777777777777",
		})).rejects.toMatchObject({ code: "generated_media_asset_in_use" });
		expect(updates).toBe(0);
	});

	test("still blocks deletion while a live Brand Profile selects the asset", async () => {
		let updates = 0;
		const tx = {
			generatedMediaJob: {
				findFirst: async () => ({
					ownerUserId: null,
					ownerWorkspaceId: ids.workspace,
					stagedFingerprint: request.fingerprint,
					resultAssetId: ids.asset,
					resultAsset: {
						id: ids.asset,
						userId: null,
						workspaceId: ids.workspace,
						fingerprint: request.fingerprint,
						provenance: "generated",
						deletedAt: null,
						profiles: [{ id: "membership" }],
						sceneTemplates: [],
						socialPostThumbnails: [],
					},
				}),
			},
			visualAsset: {
				updateMany: async () => {
					updates += 1;
					return { count: 1 };
				},
			},
			$queryRaw: async () => [],
		};
		const prisma = {
			$transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
				operation(tx),
		} as unknown as PrismaClient;
		const library = createPrismaGeneratedMediaStudioLibrary(prisma);

		await expect(
			library.softDeleteUnreferenced({
				scope,
				projectId: ids.project,
				jobId: "77777777-7777-4777-8777-777777777777",
			}),
		).rejects.toBeInstanceOf(GeneratedMediaStudioError);
		expect(updates).toBe(0);
	});

	test("resolves a deleted exact document reference with a transient URL after downgrade", async () => {
		let clipWhere: unknown;
		let assetWhere: unknown;
		const library = createPrismaGeneratedMediaStudioLibrary(
			fakePrisma({
				clip: exactClip,
				asset: {
					id: ids.asset,
					fingerprint: request.fingerprint,
					kind: "image",
					storageKey: "generated-media/private.png",
					deletedAt: new Date("2026-08-31T12:00:00.000Z"),
				},
				onClipWhere: (where) => {
					clipWhere = where;
				},
				onAssetWhere: (where) => {
					assetWhere = where;
				},
			}),
			{
				resolve: async () => ({
					state: "available" as const,
					accessUrl: "https://signed.example.test/private.png",
				}),
			},
		);

		await expect(library.resolveFrozenBrollAsset(request)).resolves.toEqual({
			assetId: ids.asset,
			fingerprint: request.fingerprint,
			mediaKind: "image",
			state: "deleted",
			accessUrl: "https://signed.example.test/private.png",
		});
		expect(clipWhere).toMatchObject({
			id: ids.clip,
			projectId: ids.project,
			project: { workspaceId: ids.workspace },
		});
		expect(assetWhere).toMatchObject({
			id: ids.asset,
			workspaceId: ids.workspace,
		});
	});

	test("resolves the same exact frozen identity from an inserted Scene Block", async () => {
		const library = createPrismaGeneratedMediaStudioLibrary(
			fakePrisma({
				clip: {
					brollPlacements: [],
					sceneBlocks: [{
						schemaVersion: 1,
						id: crypto.randomUUID(),
						anchorSec: 4,
						durationSec: 3,
						content: {
							kind: "image",
							asset: {
								kind: "visual_asset",
								id: ids.asset,
								fingerprint: request.fingerprint,
							},
							fit: "cover",
							backgroundColor: "#000000",
						},
						motion: { entrance: "none", exit: "none" },
						templateSnapshot: null,
					}],
				},
				asset: {
					id: ids.asset,
					fingerprint: request.fingerprint,
					kind: "image",
					storageKey: "generated-media/scene.png",
					deletedAt: null,
				},
			}),
			{
				resolve: async () => ({
					state: "available" as const,
					accessUrl: "https://signed.example.test/scene.png",
				}),
			},
		);

		await expect(library.resolveFrozenBrollAsset(request)).resolves.toMatchObject({
			assetId: ids.asset,
			fingerprint: request.fingerprint,
			mediaKind: "image",
			state: "available",
			accessUrl: "https://signed.example.test/scene.png",
		});
	});

	test("keeps missing storage distinct from a stale fingerprint", async () => {
		let storageCalls = 0;
		const asset = {
			id: ids.asset,
			fingerprint: request.fingerprint,
			kind: "image",
			storageKey: "generated-media/private.png",
			deletedAt: null,
		};
		const missing = createPrismaGeneratedMediaStudioLibrary(
			fakePrisma({ clip: exactClip, asset }),
			{
				resolve: async () => {
					storageCalls += 1;
					return { state: "missing" as const };
				},
			},
		);
		await expect(missing.resolveFrozenBrollAsset(request)).resolves.toMatchObject({
			state: "missing",
			accessUrl: null,
		});

		const stale = createPrismaGeneratedMediaStudioLibrary(
			fakePrisma({
				clip: exactClip,
				asset: { ...asset, fingerprint: "b".repeat(64) },
			}),
			{
				resolve: async () => {
					storageCalls += 1;
					return { state: "available" as const, accessUrl: "unreachable" };
				},
			},
		);
		await expect(stale.resolveFrozenBrollAsset(request)).resolves.toMatchObject({
			state: "fingerprint_stale",
			accessUrl: null,
		});
		expect(storageCalls).toBe(1);
	});

	test("refuses an asset that is not an exact placement in the tenant Clip", async () => {
		const library = createPrismaGeneratedMediaStudioLibrary(
			fakePrisma({ clip: { brollPlacements: [], sceneBlocks: [] }, asset: null }),
			{ resolve: async () => ({ state: "missing" as const }) },
		);
		await expect(library.resolveFrozenBrollAsset(request)).resolves.toBeNull();
	});
});
