import { randomUUID } from "node:crypto";

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

import { BrandProfileService } from "./brand-profile.service";
import {
	BrandAccessError,
	brandOwnerWhereForWorkspace,
	type BrandActorScope,
} from "./brand-ownership";
import { createPrismaBulkSchedulingStore } from "./bulk-scheduling.prisma";
import { clipExportService, sceneExportOwnerWhere } from "./clip-export.service";
import { createPrismaGeneratedMediaStore } from "./generated-media-prisma";
import { generationUsageWindow } from "./generation-usage";
import {
	createProductionSocialPublicationScheduling,
	prismaPublicationSchedulingStore,
} from "./social-publication-scheduling";
import {
	createPrismaThumbnailExtractionStore,
	createProductionThumbnailExtractionService,
} from "./thumbnail-extraction.prisma";
const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
const databaseSchema = process.env.VIZARD_EXPANSION_TEST_DATABASE_SCHEMA;
const enabled =
	process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

type Tier = "free" | "pro" | "business";
type AccessStatus = "active" | "restricted";

dbDescribe("stable Brand ownership plan transitions", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let priorPrisma: PrismaClient | undefined;
	const prismaGlobal = globalThis as unknown as {
		narriflowPrismaClient?: PrismaClient;
	};
	const brandProfiles = new BrandProfileService();

	beforeAll(() => {
		if (!databaseUrl) throw new Error("Vizard expansion test database is required");
		pool = new Pool({ connectionString: databaseUrl, max: 12 });
		prisma = new PrismaClient({
			adapter: new PrismaPg(
				pool,
				databaseSchema ? { schema: databaseSchema } : undefined,
			),
		});
		priorPrisma = prismaGlobal.narriflowPrismaClient;
		prismaGlobal.narriflowPrismaClient = prisma;
	});

	afterAll(async () => {
		prismaGlobal.narriflowPrismaClient = priorPrisma;
		await prisma?.$disconnect();
		await pool?.end();
	});

	function scopeFor(
		fixture: Pick<CampaignFixture, "user" | "workspace" | "personal">,
		pricingTier: Tier,
		status: AccessStatus = "active",
	): BrandActorScope {
		return {
			actorUserId: fixture.user.id,
			workspaceId: fixture.workspace.id,
			workspaceOwnerUserId: fixture.user.id,
			role: "owner",
			status,
			pricingTier,
			isPersonalWorkspace: fixture.personal,
		};
	}

	type CampaignFixture = Awaited<ReturnType<typeof createCampaignFixture>>;

	async function createCampaignFixture(input: {
		label: string;
		personal: boolean;
		initialTier: "pro" | "business";
	}) {
		const suffix = randomUUID();
		const user = await prisma.user.create({
			data: {
				clerkId: `stable-runtime-${input.label}-${suffix}`,
				primaryEmail: `stable-runtime-${input.label}-${suffix}@example.test`,
			},
		});
		const workspace = await prisma.workspace.create({
			data: {
				name: `Stable ${input.label}`,
				ownerUserId: user.id,
				personalOwnerUserId: input.personal ? user.id : null,
				pricingTier: input.initialTier,
				members: { create: { userId: user.id, role: "owner" } },
			},
		});
		const fixtureScope = scopeFor(
			{ user, workspace, personal: input.personal },
			input.initialTier,
		);
		const profile = await brandProfiles.create(fixtureScope, {
			name: `${input.label} profile`,
			slug: `stable-${input.label}-${suffix}`,
		});
		await brandProfiles.setDefault(fixtureScope, profile.id);
		const owner = input.personal
			? { userId: user.id }
			: { workspaceId: workspace.id };
		const generatedAsset = await prisma.visualAsset.create({
			data: {
				...owner,
				createdByUserId: user.id,
				title: `${input.label} generated still`,
				kind: "image",
				storageKey: `stable-runtime/${suffix}/generated.png`,
				contentType: "image/png",
				sizeBytes: 512n,
				width: 1080,
				height: 1920,
				fingerprint: suffix.replaceAll("-", "").padEnd(64, "0"),
				provenance: "generated",
			},
		});
		const font = await prisma.brandFont.create({
			data: {
				...owner,
				licenseConfirmedByUserId: user.id,
				family: `${input.label} Sans`,
				style: "Regular",
				weight: 400,
				format: "woff2",
				storageKey: `stable-runtime/${suffix}/font.woff2`,
				sizeBytes: 256n,
				fingerprint: suffix.replaceAll("-", "").padEnd(64, "f"),
				licenseConfirmedAt: new Date(),
			},
		});
		const scene = await prisma.sceneTemplate.create({
			data: {
				profileId: profile.id,
				sourceAssetId: generatedAsset.id,
				createdByUserId: user.id,
				name: `${input.label} frozen opener`,
				definition: {
					content: {
						kind: "image",
						asset: {
							id: generatedAsset.id,
							fingerprint: generatedAsset.fingerprint,
						},
					},
					font: { id: font.id, fingerprint: font.fingerprint },
				},
				fingerprint: suffix.replaceAll("-", "").padEnd(64, "e"),
			},
		});
		const project = await prisma.project.create({
			data: {
				title: `${input.label} campaign`,
				sourceMediaUrl: "https://media.example.test/source.mp4",
				sourceStorageKey: `stable-runtime/${suffix}/source.mp4`,
				sourceDurationSeconds: 30,
				userId: user.id,
				workspaceId: workspace.id,
				createdByUserId: user.id,
				brandProfileId: profile.id,
				brandProfileSnapshot: { profileId: profile.id },
				ingestStatus: "ready",
			},
		});
		const workflow = await prisma.workflowRun.create({
			data: {
				projectId: project.id,
				idempotencyKey: `stable-runtime:${suffix}`,
				stage: "moment_detection",
				status: "completed",
				progress: 100,
				lifecycleVersion: 2,
			},
		});
		const clip = await prisma.clip.create({
			data: {
				projectId: project.id,
				workflowRunId: workflow.id,
				index: 0,
				status: "edited",
				startSec: 0,
				endSec: 10,
				title: `${input.label} launch`,
				hookText: "Stable owner hook",
				reasoning: "Stable owner fixture",
				category: "hook",
				transcriptSlice: [],
				editorRevision: 3,
				viralityScore: 80,
				hookStrengthScore: 80,
				emotionalIntensityScore: 70,
				pacingScore: 75,
				durationOptimalityScore: 80,
				tiktokScore: 80,
				youtubeScore: 80,
				instagramScore: 80,
				llmProvider: "test",
				llmModel: "test",
			},
		});
		const clipExport = await prisma.clipExport.create({
			data: {
				projectId: project.id,
				workspaceId: workspace.id,
				createdByUserId: user.id,
				clipId: clip.id,
				editorRevision: clip.editorRevision,
				fingerprint: `stable-runtime-${suffix}`,
				resolution: "1080p",
				watermark: false,
				status: "ready",
				progress: 100,
				completedAt: new Date(),
				variants: {
					create: {
						aspectRatio: "ratio_9_16",
						resolution: "1080p",
						watermark: false,
						status: "completed",
						storageKey: `stable-runtime/${suffix}/vertical.mp4`,
						sizeBytes: 1_024n,
						durationSec: 10,
						completedAt: new Date(),
					},
				},
			},
			include: { variants: true },
		});
		const variant = clipExport.variants[0]!;
		const render = await prisma.clipRender.create({
			data: {
				clipId: clip.id,
				exportVariantId: variant.id,
				aspectRatio: variant.aspectRatio,
				status: "completed",
				storageKey: variant.storageKey,
				sizeBytes: variant.sizeBytes,
				durationSec: variant.durationSec,
				resolution: "1080p",
				editorRevision: clip.editorRevision,
				clipSnapshot: {
					sceneBlocks: [
						{
							templateId: scene.id,
							assetId: generatedAsset.id,
							assetFingerprint: generatedAsset.fingerprint,
							fontId: font.id,
							fontFingerprint: font.fingerprint,
						},
					],
				},
				completedAt: new Date(),
			},
		});

		return {
			personal: input.personal,
			user,
			workspace,
			profile,
			generatedAsset,
			font,
			scene,
			project,
			clip,
			clipExport,
			variant,
			render,
		};
	}

	async function reserveGeneratedJob(
		fixture: CampaignFixture,
		scope: BrandActorScope,
	) {
		const now = new Date("2026-08-31T12:00:00.000Z");
		const idempotencyKey = randomUUID();
		const store = createPrismaGeneratedMediaStore(prisma);
		const reserved = await store.reserve({
			scope,
			request: {
				idempotencyKey,
				projectId: fixture.project.id,
				clipId: fixture.clip.id,
				kind: "image",
				prompt: "A campaign still",
				derivedContext: "Stable ownership transition evidence",
				promptOrigin: { kind: "manual", sourceIds: [] },
				aspectRatio: "9:16",
				style: "editorial",
				durationSec: null,
				seed: null,
				title: "Stable owner still",
			},
			provider: "test",
			model: "test-image",
			usageUnits: 1,
			requestFingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
			promptCiphertext: "protected-prompt",
			promptFingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
			promptKeyVersion: "test-primary",
			usageWindow: generationUsageWindow({
				tier: scope.pricingTier,
				kind: "image",
				usageUnits: 1,
				now,
			}),
			now,
		});
		return prisma.generatedMediaJob.findUniqueOrThrow({
			where: { id: reserved.job.id },
		});
	}

	async function completeThumbnail(
		fixture: CampaignFixture,
		label: string,
	) {
		const now = new Date("2026-08-31T12:01:00.000Z");
		const claimId = randomUUID();
		const claimExpiresAt = new Date(now.getTime() + 60_000);
		const job = await prisma.thumbnailExtractionJob.create({
			data: {
				workspaceId: fixture.workspace.id,
				projectId: fixture.project.id,
				actorUserId: fixture.user.id,
				idempotencyKey: randomUUID(),
				requestFingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
				platform: "youtube_shorts",
				exportVariantId: fixture.variant.id,
				sourceStorageKey: fixture.variant.storageKey!,
				sourceTimeMs: 1_000,
				title: `${label} extracted thumbnail`,
				status: "processing",
				attempts: 1,
				claimId,
				claimExpiresAt,
			},
		});
		const destinationStorageKey = `visual-assets/extracted/${fixture.workspace.id}/${job.id}/attempt-1.jpg`;
		const store = createPrismaThumbnailExtractionStore({ prisma });
		await store.prepareOutput({
			jobId: job.id,
			claimId,
			claimExpiresAt,
			destinationStorageKey,
			now,
		});
		const assetId = randomUUID();
		await store.complete({
			jobId: job.id,
			claimId,
			asset: {
				id: assetId,
				workspaceId: fixture.workspace.id,
				createdByUserId: fixture.user.id,
				title: `${label} extracted thumbnail`,
				kind: "image",
				storageKey: destinationStorageKey,
				contentType: "image/jpeg",
				sizeBytes: 2_048,
				width: 1080,
				height: 1920,
				durationSec: null,
				hasAudio: null,
				videoCodec: null,
				audioCodec: null,
				fingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
				provenance: "extracted",
				sourceExportVariantId: fixture.variant.id,
				sourceTimeMs: 1_000,
				deletedAt: null,
				createdAt: now,
			},
			now,
		});
		return {
			job,
			asset: await prisma.visualAsset.findUniqueOrThrow({
				where: { id: assetId },
			}),
		};
	}

	async function createFrozenPublication(
		fixture: CampaignFixture,
		thumbnailAssetId: string,
		thumbnailFingerprint: string,
	) {
		const scheduledFor = new Date("2026-09-01T12:00:00.000Z");
		const socialPost = await prisma.socialPost.create({
			data: {
				workspaceId: fixture.workspace.id,
				projectId: fixture.project.id,
				createdByUserId: fixture.user.id,
				clipId: fixture.clip.id,
				thumbnailAssetId,
				thumbnailFingerprint,
				platform: "youtube_shorts",
				status: "scheduled",
				clientIdempotencyKey: randomUUID(),
				immutableRequestHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
				caption: "Approved campaign caption",
				aspectRatio: "ratio_9_16",
				scheduledFor,
			},
		});
		await prisma.frozenPublicationState.create({
			data: {
				socialPostId: socialPost.id,
				clipExportId: fixture.clipExport.id,
				clipExportVariantId: fixture.variant.id,
				platform: "youtube_shorts",
				editorRevision: fixture.clip.editorRevision,
				exportFingerprint: fixture.clipExport.fingerprint,
				storageKey: fixture.variant.storageKey,
				sizeBytes: fixture.variant.sizeBytes,
				durationSec: fixture.variant.durationSec,
				aspectRatio: fixture.variant.aspectRatio,
				caption: socialPost.caption,
				providerSettings: {},
				capabilityVersion: "stable-owner-v1",
				scheduledFor,
				mediaReadyAt: new Date(),
			},
		});
		return socialPost;
	}

	async function expectCampaignReadable(input: {
		fixture: CampaignFixture;
		tier: Tier;
		status?: AccessStatus;
		generatedJobId: string;
		thumbnailJobId: string;
		thumbnailAssetId: string;
		socialPostId: string;
	}) {
		const status = input.status ?? "active";
		await prisma.workspace.update({
			where: { id: input.fixture.workspace.id },
			data: { pricingTier: input.tier, status },
		});
		const scope = scopeFor(input.fixture, input.tier, status);
		const ownerWhere = brandOwnerWhereForWorkspace({
			workspaceId: input.fixture.workspace.id,
			personalOwnerUserId: input.fixture.personal
				? input.fixture.user.id
				: null,
		});
		const [profiles, defaultId, assets, fonts, jobs, extracted, clipExport, post] =
			await Promise.all([
				brandProfiles.list(scope),
				brandProfiles.getDefaultId(scope),
				prisma.visualAsset.findMany({ where: ownerWhere }),
				prisma.brandFont.findMany({ where: ownerWhere }),
				createPrismaGeneratedMediaStore(prisma).list(
					scope,
					input.fixture.project.id,
				),
				createProductionThumbnailExtractionService({
					async extract() {
						throw new Error("read-only transition test");
					},
				}).get(
					{
						actorUserId: input.fixture.user.id,
						workspaceId: input.fixture.workspace.id,
						projectId: input.fixture.project.id,
					},
					input.thumbnailJobId,
				),
				clipExportService.getOwned(
					input.fixture.user.id,
					input.fixture.project.id,
					input.fixture.clip.id,
					input.fixture.clipExport.id,
					input.fixture.workspace.id,
				),
				prismaPublicationSchedulingStore.read(
					input.fixture.workspace.id,
					input.socialPostId,
				),
			]);

		expect(profiles.map((profile) => profile.id)).toContain(
			input.fixture.profile.id,
		);
		expect(defaultId).toBe(input.fixture.profile.id);
		expect(assets.map((asset) => asset.id)).toEqual(
			expect.arrayContaining([
				input.fixture.generatedAsset.id,
				input.thumbnailAssetId,
			]),
		);
		expect(fonts.map((font) => font.id)).toContain(input.fixture.font.id);
		expect(jobs.map((job) => job.id)).toContain(input.generatedJobId);
		expect(extracted.asset?.id).toBe(input.thumbnailAssetId);
		expect(clipExport?.id).toBe(input.fixture.clipExport.id);
		expect(post).toMatchObject({
			id: input.socialPostId,
			thumbnailAssetId: input.thumbnailAssetId,
			frozen: {
				clipExportId: input.fixture.clipExport.id,
				clipExportVariantId: input.fixture.variant.id,
			},
		});

		const frozenRender = await prisma.clipRender.findUniqueOrThrow({
			where: { id: input.fixture.render.id },
		});
		expect(frozenRender.clipSnapshot).toMatchObject({
			sceneBlocks: [
				{
					templateId: input.fixture.scene.id,
					assetId: input.fixture.generatedAsset.id,
					fontId: input.fixture.font.id,
				},
			],
		});
		const sceneOwner = sceneExportOwnerWhere({
			workspaceId: input.fixture.workspace.id,
			workspace: {
				personalOwnerUserId: input.fixture.personal
					? input.fixture.user.id
					: null,
			},
		});
		expect(
			await prisma.visualAsset.findFirst({
				where: { id: input.fixture.generatedAsset.id, ...sceneOwner },
			}),
		).not.toBeNull();
		expect(
			await prisma.brandFont.findFirst({
				where: { id: input.fixture.font.id, ...sceneOwner },
			}),
		).not.toBeNull();
		expect(
			await createPrismaBulkSchedulingStore(prisma).readThumbnail({
				actorUserId: input.fixture.user.id,
				ownerUserId: input.fixture.user.id,
				workspaceId: input.fixture.workspace.id,
				projectId: input.fixture.project.id,
				approvalPrincipal: {
					kind: "browser",
					actorUserId: input.fixture.user.id,
				},
				assetId: input.thumbnailAssetId,
			}),
		).toMatchObject({ id: input.thumbnailAssetId });
	}

	async function expectWriteDenied(
		fixture: CampaignFixture,
		tier: Tier,
		status: AccessStatus,
	) {
		const scope = scopeFor(fixture, tier, status);
		await expect(
			brandProfiles.create(scope, {
				name: "Denied profile",
				slug: `denied-${randomUUID()}`,
			}),
		).rejects.toBeInstanceOf(BrandAccessError);

		const thumbnails = createProductionThumbnailExtractionService({
			async extract() {
				throw new Error("authorization must run before processing");
			},
		});
		const deniedThumbnail = thumbnails.request(
			{
				actorUserId: fixture.user.id,
				workspaceId: fixture.workspace.id,
				projectId: fixture.project.id,
			},
			{
				idempotencyKey: randomUUID(),
				platform: "youtube_shorts",
				exportVariantId: fixture.variant.id,
				sourceTimeSec: 1,
				title: "Denied thumbnail",
			},
		);
		if (status === "active") {
			await expect(deniedThumbnail).rejects.toMatchObject({
				code: "thumbnail_extraction_feature_unavailable",
			});
		} else {
			await expect(deniedThumbnail).rejects.toBeDefined();
		}
	}

	test("keeps the full personal campaign readable through Pro, Business, Pro, Free, and restricted states", async () => {
		const fixture = await createCampaignFixture({
			label: "personal",
			personal: true,
			initialTier: "pro",
		});
		const unrelatedUser = await prisma.user.create({
			data: { clerkId: `stable-runtime-unrelated-${randomUUID()}` },
		});
		await expect(
			Promise.resolve(prisma.workspace.update({
				where: { id: fixture.workspace.id },
				data: { ownerUserId: unrelatedUser.id },
			})),
		).rejects.toBeDefined();
		expect(
			await prisma.workspace.findUniqueOrThrow({
				where: { id: fixture.workspace.id },
			}),
		).toMatchObject({
			ownerUserId: fixture.user.id,
			personalOwnerUserId: fixture.user.id,
		});

		await prisma.workspace.update({
			where: { id: fixture.workspace.id },
			data: { pricingTier: "business" },
		});
		const businessScope = scopeFor(fixture, "business");
		const businessProfile = await brandProfiles.create(businessScope, {
			name: "Personal Business profile",
			slug: `personal-business-${randomUUID()}`,
		});
		const generatedJob = await reserveGeneratedJob(fixture, businessScope);
		const thumbnail = await completeThumbnail(fixture, "personal");
		const socialPost = await createFrozenPublication(
			fixture,
			thumbnail.asset.id,
			thumbnail.asset.fingerprint,
		);
		expect(
			await prisma.brandProfile.findUniqueOrThrow({
				where: { id: businessProfile.id },
			}),
		).toMatchObject({ userId: fixture.user.id, workspaceId: null });
		expect(generatedJob).toMatchObject({
			ownerUserId: fixture.user.id,
			ownerWorkspaceId: null,
		});
		expect(thumbnail.asset).toMatchObject({
			userId: fixture.user.id,
			workspaceId: null,
		});

		const readInput = {
			fixture,
			generatedJobId: generatedJob.id,
			thumbnailJobId: thumbnail.job.id,
			thumbnailAssetId: thumbnail.asset.id,
			socialPostId: socialPost.id,
		};
		await expectCampaignReadable({ ...readInput, tier: "pro" });
		await expectCampaignReadable({ ...readInput, tier: "business" });
		await expectCampaignReadable({ ...readInput, tier: "pro" });
		await expectCampaignReadable({ ...readInput, tier: "free" });
		await expectWriteDenied(fixture, "free", "active");
		await expectCampaignReadable({
			...readInput,
			tier: "free",
			status: "restricted",
		});
		await expectWriteDenied(fixture, "free", "restricted");
		await expect(
			createProductionSocialPublicationScheduling().schedule({
				actorUserId: fixture.user.id,
				approvalPrincipal: {
					kind: "browser",
					actorUserId: fixture.user.id,
				},
				ownerUserId: fixture.user.id,
				workspaceId: fixture.workspace.id,
				projectId: fixture.project.id,
				clientIdempotencyKey: randomUUID(),
				clipId: fixture.clip.id,
				expectedEditorRevision: fixture.clip.editorRevision,
				accountId: null,
				platform: "youtube_shorts",
				caption: "Denied while restricted",
				aspectRatio: "9:16",
				resolution: "1080p",
				scheduledFor: new Date(Date.now() + 60_000),
				providerSettings: {},
				approvalOverrideReason: null,
			}),
		).rejects.toBeDefined();
	});

	test("keeps team ownership workspace-scoped through downgrade and re-upgrade", async () => {
		const fixture = await createCampaignFixture({
			label: "team",
			personal: false,
			initialTier: "business",
		});
		const businessScope = scopeFor(fixture, "business");
		const generatedJob = await reserveGeneratedJob(fixture, businessScope);
		const thumbnail = await completeThumbnail(fixture, "team");
		const socialPost = await createFrozenPublication(
			fixture,
			thumbnail.asset.id,
			thumbnail.asset.fingerprint,
		);
		expect(generatedJob).toMatchObject({
			ownerUserId: null,
			ownerWorkspaceId: fixture.workspace.id,
		});
		expect(thumbnail.asset).toMatchObject({
			userId: null,
			workspaceId: fixture.workspace.id,
		});

		const readInput = {
			fixture,
			generatedJobId: generatedJob.id,
			thumbnailJobId: thumbnail.job.id,
			thumbnailAssetId: thumbnail.asset.id,
			socialPostId: socialPost.id,
		};
		await expectCampaignReadable({ ...readInput, tier: "business" });
		await expectCampaignReadable({ ...readInput, tier: "free" });
		await expectWriteDenied(fixture, "free", "active");
		await prisma.workspace.update({
			where: { id: fixture.workspace.id },
			data: { pricingTier: "business" },
		});
		const restoredProfile = await brandProfiles.create(businessScope, {
			name: "Restored team profile",
			slug: `restored-team-${randomUUID()}`,
		});
		expect(
			await prisma.brandProfile.findUniqueOrThrow({
				where: { id: restoredProfile.id },
			}),
		).toMatchObject({ userId: null, workspaceId: fixture.workspace.id });
		await expectCampaignReadable({ ...readInput, tier: "business" });
	});
});
