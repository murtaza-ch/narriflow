import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  DEFAULT_CAPTION_PRESET,
  applyEditorAction,
  editorDocumentSchema,
  recordAnalyticsEventSchema,
} from "@narriflow/validators";
import { Pool } from "pg";
import { CampaignOperationError, CampaignOperationService, campaignOperationService } from "./campaign-operation.service";
import { clipEditorDocumentPersistence } from "./clip-editor-document-persistence";
import {
  ReviewService,
  ReviewServiceError,
  reviewService,
} from "./review.service";
import { createReviewRolloutPolicy } from "./review-rollout";
import { sceneTemplateService } from "./scene-template.service";
import { socialOAuthService } from "./social-oauth.service";
import { visualAssetService } from "./visual-asset.service";
import { BrandFontReferenceError, brandFontService } from "./brand-font.service";
import { clipExportService } from "./clip-export.service";
import {
  buildBrandProfileSnapshot,
  buildBrandTemplateSnapshot,
} from "./brand-profile.service";
import { AnalyticsService } from "./analytics.service";
import { createPrismaBulkSchedulingStore } from "./bulk-scheduling.prisma";
import { GeneratedMediaInsertionService } from "./generated-media-insertion";
import { createPrismaGeneratedMediaInsertionStore } from "./generated-media-insertion.prisma";
import {
  GeneratedMediaService,
  createGeneratedMediaPromptProtection,
  type GeneratedMediaProvider,
} from "./generated-media";
import { createPrismaGeneratedMediaStore } from "./generated-media-prisma";

const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
const databaseSchema = process.env.VIZARD_EXPANSION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;
const sessionSecret = "vizard-expansion-review-session-secret-for-tests";

setDefaultTimeout(180_000);

dbDescribe("Vizard expansion PostgreSQL contracts", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };

  beforeAll(() => {
    if (!databaseUrl) throw new Error("Vizard expansion test database is required");
    pool = new Pool({ connectionString: databaseUrl, max: 12 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(
        pool,
        databaseSchema ? { schema: databaseSchema } : undefined,
      ),
      transactionOptions: { maxWait: 10_000, timeout: 30_000 },
    });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function fixture(label: string) {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `vizard-${label}-${suffix}`, primaryEmail: `vizard-${label}-${suffix}@example.test` } });
    const workspace = await prisma.workspace.create({ data: {
      name: `Vizard ${label}`,
      ownerUserId: user.id,
      pricingTier: "business",
      members: { create: { userId: user.id, role: "owner" } },
    } });
    const project = await prisma.project.create({ data: {
      title: `Project ${label}`,
      sourceMediaUrl: "https://media.example.test/source.mp4",
      sourceStorageKey: `fixtures/${suffix}/source.mp4`,
      userId: user.id,
      workspaceId: workspace.id,
      createdByUserId: user.id,
      ingestStatus: "ready",
    } });
    const workflow = await prisma.workflowRun.create({ data: {
      projectId: project.id,
      idempotencyKey: `fixture:${suffix}`,
      stage: "moment_detection",
      status: "completed",
      progress: 100,
      lifecycleVersion: 2,
    } });
    const clip = await prisma.clip.create({ data: {
      projectId: project.id,
      workflowRunId: workflow.id,
      index: 0,
      status: "edited",
      startSec: 0,
      endSec: 10,
      title: "Launch / teaser",
      hookText: "A strong hook",
      reasoning: "Fixture",
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
    } });
    const clipExport = await prisma.clipExport.create({ data: {
      projectId: project.id,
      workspaceId: workspace.id,
      createdByUserId: user.id,
      clipId: clip.id,
      editorRevision: 3,
      fingerprint: `fixture-${suffix}`,
      resolution: "1080p",
      watermark: false,
      status: "ready",
      progress: 100,
      completedAt: new Date(),
      variants: { create: [
        { aspectRatio: "ratio_9_16", resolution: "1080p", watermark: false, status: "completed", storageKey: `fixtures/${suffix}/vertical.mp4`, sizeBytes: 64n, durationSec: 10, completedAt: new Date() },
        { aspectRatio: "ratio_1_1", resolution: "1080p", watermark: false, status: "completed", storageKey: `fixtures/${suffix}/square.mp4`, sizeBytes: 32n, durationSec: 10, completedAt: new Date() },
      ] },
    }, include: { variants: true } });
    return { user, workspace, project, clip, clipExport };
  }

	test("atomically persists an idempotent generated-image placement and editor revision", async () => {
		const current = await fixture("generated-media-insertion");
		const asset = await prisma.visualAsset.create({
			data: {
				workspaceId: current.workspace.id,
				createdByUserId: current.user.id,
				title: "Generated campaign still",
				kind: "image",
				storageKey: `fixtures/${randomUUID()}/generated.png`,
				contentType: "image/png",
				sizeBytes: 64n,
				width: 1080,
				height: 1920,
				fingerprint: "a".repeat(64),
				provenance: "generated",
			},
		});
		const job = await prisma.generatedMediaJob.create({
			data: {
				workspaceId: current.workspace.id,
				projectId: current.project.id,
				clipId: current.clip.id,
				actorUserId: current.user.id,
				ownerWorkspaceId: current.workspace.id,
				kind: "image",
				status: "completed",
				idempotencyKey: randomUUID(),
				requestFingerprint: "b".repeat(64),
				provider: "test",
					model: "configured-image-model",
					promptFingerprint: "c".repeat(64),
					promptKeyVersion: "test-primary",
				promptOriginKind: "manual",
				promptOriginSourceIds: [],
				aspectRatio: "9:16",
				style: "editorial",
				resultAssetId: asset.id,
				stagedFingerprint: asset.fingerprint,
				completedAt: new Date(),
			},
		});
		await prisma.clipRender.create({
			data: {
				clipId: current.clip.id,
				aspectRatio: "ratio_9_16",
				status: "completed",
				storageKey: `fixtures/${randomUUID()}/stale-render.mp4`,
			},
		});
		const service = new GeneratedMediaInsertionService({
			store: createPrismaGeneratedMediaInsertionStore(prisma),
			now: () => new Date("2026-08-31T12:00:00.000Z"),
		});
		const request = {
			idempotencyKey: randomUUID(),
			jobId: job.id,
			projectId: current.project.id,
			clipId: current.clip.id,
			baseRevision: 3,
			action: {
				kind: "insert_broll" as const,
				placementId: randomUUID(),
				startSec: 1,
				endSec: 3,
			},
		};
		const actor = {
			actorUserId: current.user.id,
			workspaceId: current.workspace.id,
			workspaceOwnerUserId: current.user.id,
			role: "owner" as const,
			status: "active" as const,
			pricingTier: "business",
			isPersonalWorkspace: false,
		};

		const inserted = await service.insert(actor, request);
		const replay = await service.insert(actor, request);
		const [storedClip, storedJob, commands, renderCount, cleanupCount] =
			await Promise.all([
				prisma.clip.findUniqueOrThrow({ where: { id: current.clip.id } }),
				prisma.generatedMediaJob.findUniqueOrThrow({ where: { id: job.id } }),
				prisma.generatedMediaInsertion.count({ where: { jobId: job.id } }),
				prisma.clipRender.count({
					where: { clipId: current.clip.id, exportVariantId: null },
				}),
				prisma.mediaCleanupObligation.count({
					where: { clipId: current.clip.id, cleanupClass: "mutable_render" },
				}),
			]);

		expect(inserted).toMatchObject({ revision: 4, replayed: false });
		expect(replay).toEqual({ ...inserted, replayed: true });
		expect(storedClip.editorRevision).toBe(4);
		expect(editorDocumentSchema.parse({
			...inserted.document,
			brollPlacements: storedClip.brollPlacements,
		}).brollPlacements).toEqual(inserted.document.brollPlacements);
		expect(storedJob).toMatchObject({
			insertionCount: 1,
			lastInsertionKind: "broll",
		});
		expect({ commands, renderCount, cleanupCount }).toEqual({
			commands: 1,
			renderCount: 0,
			cleanupCount: 1,
		});
	});

	test("atomically admits one Free image trial and retains its billing row after Project deletion", async () => {
		const current = await fixture("generated-media-quota-retention");
		const store = createPrismaGeneratedMediaStore(prisma);
		const provider: GeneratedMediaProvider = {
			alias: "test-image",
			async submit() {
				throw new Error("provider must not run during admission");
			},
			async poll() {
				throw new Error("provider must not run during admission");
			},
			async cancel() {
				return { state: "unsupported" };
			},
			async retrieve() {
				throw new Error("provider must not run during admission");
			},
		};
		const now = new Date("2026-08-31T12:00:00.000Z");
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config: {
				image: {
					enabled: true,
					provider: provider.alias,
					model: "fixture-model",
					maxConcurrency: 1,
					usageUnits: 1,
					dailyUsageLimit: 5,
					dailyAbuseLimit: 10,
					maxOutputBytes: 1024,
				},
				video: { enabled: false, reason: "entry_gate_closed" },
			},
			promptProtection: createGeneratedMediaPromptProtection({
				activeKeyVersion: "test-primary",
				encryptionKeys: {
					"test-primary": "test-encryption-key-with-at-least-32-characters",
				},
				fingerprintKey: "test-fingerprint-key-with-at-least-32-characters",
			}),
			now: () => now,
		});
		const actor = {
			actorUserId: current.user.id,
			workspaceId: current.workspace.id,
			workspaceOwnerUserId: current.user.id,
			role: "owner" as const,
			status: "active" as const,
			pricingTier: "free",
			isPersonalWorkspace: false,
		};
		const command = (idempotencyKey: string) => ({
			idempotencyKey,
			projectId: current.project.id,
			clipId: current.clip.id,
			kind: "image" as const,
			prompt: "A quiet studio",
			derivedContext: null,
			promptOrigin: { kind: "manual" as const, sourceIds: [] },
			aspectRatio: "9:16" as const,
			style: "editorial" as const,
		});

		const outcomes = await Promise.allSettled([
			service.submit(actor, command(randomUUID())),
			service.submit(actor, command(randomUUID())),
		]);
		const admitted = outcomes.find((outcome) => outcome.status === "fulfilled");
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toMatchObject([
			{ reason: { code: "generated_media_usage_exhausted" } },
		]);
		if (!admitted || admitted.status !== "fulfilled") throw new Error("trial missing");

		await prisma.project.delete({ where: { id: current.project.id } });
		expect(await store.get(actor, admitted.value.id)).toMatchObject({
			projectId: current.project.id,
			clipId: null,
		});
		expect((await service.usageSummary(actor)).image).toMatchObject({
			allowance: { committedUnits: 1, availableUnits: 0 },
			settlement: { reservedUnits: 1 },
		});
	});

	test("allows separate jobs to settle onto the same generated Visual Asset", async () => {
		const current = await fixture("generated-media-shared-result");
		const asset = await prisma.visualAsset.create({
			data: {
				workspaceId: current.workspace.id,
				createdByUserId: current.user.id,
				title: "Shared generated still",
				kind: "image",
				storageKey: `fixtures/${randomUUID()}/shared.png`,
				contentType: "image/png",
				sizeBytes: 64n,
				width: 1080,
				height: 1920,
				fingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
				provenance: "generated",
			},
		});
		const base = {
			workspaceId: current.workspace.id,
			projectId: current.project.id,
			clipId: current.clip.id,
			actorUserId: current.user.id,
			ownerWorkspaceId: current.workspace.id,
			kind: "image",
			status: "completed",
			requestFingerprint: "a".repeat(64),
			provider: "fixture-provider",
			model: "fixture-model",
			promptFingerprint: "b".repeat(64),
			promptKeyVersion: "test-primary",
			promptOriginKind: "manual",
			promptOriginSourceIds: [],
			aspectRatio: "9:16",
			style: "editorial",
			resultAssetId: asset.id,
			completedAt: new Date(),
		};

		await prisma.generatedMediaJob.createMany({
			data: [
				{ ...base, idempotencyKey: randomUUID() },
				{ ...base, idempotencyKey: randomUUID() },
			],
		});

		expect(
			await prisma.generatedMediaJob.count({ where: { resultAssetId: asset.id } }),
		).toBe(2);
	});

	test("claims another Workspace after a capped tenant fills the first queue page", async () => {
		const capped = await fixture("generated-media-capped-claim");
		const eligible = await fixture("generated-media-eligible-claim");
		const store = createPrismaGeneratedMediaStore(prisma);
		const now = new Date("2026-08-31T12:00:00.000Z");
		const queueEpoch = new Date("2000-01-01T00:00:00.000Z");
		const activeId = randomUUID();
		const eligibleId = randomUUID();
		const cappedQueuedIds = Array.from({ length: 25 }, () => randomUUID());
		const job = (input: {
			id: string;
			workspaceId: string;
			projectId: string;
			actorUserId: string;
			status: "queued" | "waiting";
			createdAt: Date;
			providerReference?: string;
			nextPollAt?: Date;
		}) => ({
			id: input.id,
			workspaceId: input.workspaceId,
			projectId: input.projectId,
			actorUserId: input.actorUserId,
			ownerWorkspaceId: input.workspaceId,
			kind: "image",
			status: input.status,
			idempotencyKey: randomUUID(),
			requestFingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
			provider: "fixture-provider",
			model: "fixture-model",
			promptCiphertext: "protected-prompt",
			promptFingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
			promptKeyVersion: "test-primary",
			promptOriginKind: "manual",
			promptOriginSourceIds: [],
			aspectRatio: "9:16",
			style: "editorial",
			providerReference: input.providerReference,
			nextAttemptAt: now,
			nextPollAt: input.nextPollAt,
			createdAt: input.createdAt,
			updatedAt: input.createdAt,
		});
		await prisma.generatedMediaJob.createMany({
			data: [
				job({
					id: activeId,
					workspaceId: capped.workspace.id,
					projectId: capped.project.id,
					actorUserId: capped.user.id,
					status: "waiting",
					providerReference: "capped-provider-operation",
					nextPollAt: new Date(now.getTime() + 60_000),
					createdAt: new Date(queueEpoch.getTime() - 1_000),
				}),
				...cappedQueuedIds.map((id, index) =>
					job({
						id,
						workspaceId: capped.workspace.id,
						projectId: capped.project.id,
						actorUserId: capped.user.id,
						status: "queued",
						createdAt: new Date(queueEpoch.getTime() + index),
					}),
				),
				job({
					id: eligibleId,
					workspaceId: eligible.workspace.id,
					projectId: eligible.project.id,
					actorUserId: eligible.user.id,
					status: "queued",
					createdAt: new Date(queueEpoch.getTime() + 100),
				}),
			],
		});
		const dayStart = new Date("2026-08-31T00:00:00.000Z");
		const dayEnd = new Date("2026-09-01T00:00:00.000Z");
		await prisma.generationUsageReservation.createMany({
			data: [activeId, ...cappedQueuedIds, eligibleId].map((jobId, index) => ({
				jobId,
				workspaceId:
					index <= cappedQueuedIds.length
						? capped.workspace.id
						: eligible.workspace.id,
				kind: "image",
				reservedUnits: 1,
				usagePolicy: "metered",
				allowancePeriod: "calendar_day_utc",
				allowanceLimitUnits: 20,
				allowanceStartedAt: dayStart,
				allowanceEndsAt: dayEnd,
				dailyAbuseLimitUnits: 40,
				dailyAbuseStartedAt: dayStart,
				dailyAbuseEndsAt: dayEnd,
				createdAt: now,
				updatedAt: now,
			})),
		});

		const claim = await store.claimNext({
			workerId: "fixture-worker",
			now,
			leaseMs: 60_000,
			enabledKinds: ["image"],
			maxConcurrency: { image: 1 },
		});

		expect(claim).toMatchObject({
			jobId: eligibleId,
			workspaceId: eligible.workspace.id,
		});
	});

  test("records campaign lifecycle analytics exactly once and reports the approved interval", async () => {
    const current = await fixture("program-analytics");
    const windowStart = new Date(Date.now() - 60_000);
    const renderRun = await prisma.workflowRun.create({
      data: {
        projectId: current.project.id,
        idempotencyKey: `analytics-render:${randomUUID()}`,
        stage: "clip_rendering",
        status: "running",
        progress: 50,
        lifecycleVersion: 2,
        requestedCount: 2,
      },
    });
    await prisma.workflowRun.update({
      where: { id: renderRun.id },
      data: {
        status: "partial",
        progress: 100,
        succeededCount: 1,
        failedCount: 1,
      },
    });
    await prisma.workflowRun.update({
      where: { id: renderRun.id },
      data: { progress: 100 },
    });

    const override = await prisma.reviewApprovalOverride.create({
      data: {
        workspaceId: current.workspace.id,
        projectId: current.project.id,
        actorUserId: current.user.id,
        idempotencyKey: randomUUID(),
        requestFingerprint: "b".repeat(64),
        exportIds: [current.clipExport.id],
        reason: "Approved analytics fixture exception",
      },
    });
    const socialPost = await prisma.socialPost.create({
      data: {
        workspaceId: current.workspace.id,
        projectId: current.project.id,
        createdByUserId: current.user.id,
        clipId: current.clip.id,
        reviewApprovalOverrideId: override.id,
        platform: "youtube_shorts",
        status: "scheduled",
        clientIdempotencyKey: randomUUID(),
        immutableRequestHash: "c".repeat(64),
        caption: "Content-free analytics fixture",
        scheduledFor: new Date(Date.now() + 3_600_000),
      },
    });
    const firstReviewRound = await prisma.reviewRound.create({
      data: {
        workspaceId: current.workspace.id,
        projectId: current.project.id,
        createdByUserId: current.user.id,
        revision: 1,
        status: "superseded",
        title: "Analytics review round 1",
        accessTokenHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        supersededAt: new Date(),
      },
    });
    await prisma.reviewRound.create({
      data: {
        workspaceId: current.workspace.id,
        projectId: current.project.id,
        createdByUserId: current.user.id,
        previousRoundId: firstReviewRound.id,
        revision: 2,
        status: "approved",
        title: "Analytics review round 2",
        accessTokenHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        decision: "approved",
        decidedAt: new Date(),
      },
    });
    const publicationVariant = current.clipExport.variants[0]!;
    const frozenPublication = await prisma.frozenPublicationState.create({
      data: {
        socialPostId: socialPost.id,
        clipExportId: current.clipExport.id,
        clipExportVariantId: publicationVariant.id,
        platform: "youtube_shorts",
        editorRevision: current.clip.editorRevision,
        exportFingerprint: current.clipExport.fingerprint,
        storageKey: publicationVariant.storageKey,
        sizeBytes: publicationVariant.sizeBytes,
        durationSec: publicationVariant.durationSec,
        aspectRatio: publicationVariant.aspectRatio,
        caption: socialPost.caption,
        providerSettings: {},
        capabilityVersion: "analytics-fixture-v1",
        scheduledFor: socialPost.scheduledFor!,
        mediaReadyAt: new Date(),
      },
    });
    const attemptNow = new Date();
    await prisma.socialPublicationAttempt.create({
      data: {
        socialPostId: socialPost.id,
        frozenStateId: frozenPublication.id,
        attemptNumber: 1,
        idempotencyKey: `analytics-attempt:${randomUUID()}`,
        phase: "failed",
        outcome: "failed",
        failureCode: "fixture_provider_failure",
        nextActionAt: attemptNow,
        processingDeadline: new Date(attemptNow.getTime() + 60_000),
        reconciliationDeadline: new Date(attemptNow.getTime() + 120_000),
        terminalAt: attemptNow,
      },
    });
    await prisma.generatedMediaJob.createMany({
      data: ["failed", "rejected"].map((status) => ({
        workspaceId: current.workspace.id,
        projectId: current.project.id,
        clipId: current.clip.id,
        actorUserId: current.user.id,
        ownerWorkspaceId: current.workspace.id,
        kind: "image",
        status,
        idempotencyKey: randomUUID(),
        requestFingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        provider: "fixture-provider",
        model: "fixture-model",
        promptFingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        promptKeyVersion: "test-primary",
        promptOriginKind: "manual",
        promptOriginSourceIds: [],
        aspectRatio: "9:16",
        style: "editorial",
			moderationOutcome: status === "rejected" ? "rejected" : "passed",
        errorCode:
          status === "rejected" ? "generated_media_rejected" : "provider_failed",
        completedAt: new Date(),
      })),
    });
    const store = createPrismaBulkSchedulingStore(prisma);
    const idempotencyKey = randomUUID();
    let executions = 0;
    const open = () =>
      store.open({
        actorUserId: current.user.id,
        workspaceId: current.workspace.id,
        projectId: current.project.id,
        idempotencyKey,
        requestFingerprint: "a".repeat(64),
        requestedCount: 2,
        async execute(operationId) {
          executions += 1;
          return {
            operationId,
            status: "partial",
            counts: { scheduled: 1, failed: 1 },
            items: [
              {
                itemKey: "scheduled",
                clipId: current.clip.id,
                accountId: randomUUID(),
                status: "scheduled",
                postId: socialPost.id,
                scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
                errorCode: null,
              },
              {
                itemKey: "failed",
                clipId: current.clip.id,
                accountId: randomUUID(),
                status: "failed",
                postId: null,
                scheduledFor: null,
                errorCode: "fixture_failed",
              },
            ],
          };
        },
      });
    const first = await open();
    const replay = await open();
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(executions).toBe(1);
    const operationId = first.result.operationId;
    expect(
      await prisma.campaignOperationItem.findFirst({
        where: { operationId, itemKey: "scheduled" },
        select: { reviewApprovalOverrideId: true },
      }),
    ).toEqual({ reviewApprovalOverrideId: override.id });
    await prisma.campaignOperation.update({
      where: { id: operationId },
      data: { completedAt: new Date() },
    });

    const events = await prisma.projectAnalyticsEvent.findMany({
      where: {
        projectId: current.project.id,
        type: {
          in: [
            "clips_ready",
            "campaign_operation_started",
            "campaign_operation_completed",
            "campaign_scheduled",
          ],
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(events.map((event) => event.type).sort()).toEqual([
      "campaign_operation_completed",
      "campaign_operation_started",
      "campaign_scheduled",
      "clips_ready",
    ]);
    for (const event of events) {
      expect(() =>
        recordAnalyticsEventSchema.parse({
          type: event.type,
          clipId: event.clipId,
          platform: event.platform,
          metadata: event.metadata,
        }),
      ).not.toThrow();
    }
    expect(
      events.find((event) => event.type === "campaign_scheduled")?.metadata,
    ).toMatchObject({
      selectedCount: 2,
      scheduledCount: 1,
      failedCount: 1,
      approvalOverrides: 1,
      outcome: "partial",
    });

    const report = await new AnalyticsService().getCampaignCompletionIntervalReport({
      windowStart,
      windowEnd: new Date(Date.now() + 60_000),
      workspaceIds: [current.workspace.id],
    });
    expect(report).toMatchObject({
      eligibleProjects: 1,
      scheduledProjects: 1,
      completionRate: 1,
      scheduledDeliverables: 1,
      approvalOverrides: 1,
      overriddenProjects: 1,
      approvalOverrideProjectRate: 1,
      reviewRevisions: {
        projectsWithRounds: 1,
        median: 2,
        p90: 2,
      },
      publicationAttempts: {
        terminal: 1,
        succeeded: 0,
        failed: 1,
        needsAttention: 0,
        failureRate: 1,
        byPlatform: [
          {
            platform: "youtube_shorts",
            terminal: 1,
            succeeded: 0,
            failed: 1,
            needsAttention: 0,
            failureRate: 1,
          },
        ],
      },
      generatedProviderOutcomes: {
        terminal: 2,
        completed: 0,
        failed: 1,
        rejected: 1,
        failureRate: 0.5,
        rejectionRate: 0.5,
        byProviderKind: [
          {
            providerAlias: "fixture-provider",
            kind: "image",
            terminal: 2,
            completed: 0,
            failed: 1,
            rejected: 1,
            failureRate: 0.5,
            rejectionRate: 0.5,
          },
        ],
      },
    });
    expect(report.durationSeconds.median).toBeGreaterThanOrEqual(0);
    expect(report.durationSeconds.p90).toBeGreaterThanOrEqual(
      report.durationSeconds.median ?? 0,
    );
  });

  test("enforces coherent durable thumbnail evidence on Social Posts", async () => {
    const current = await fixture("thumbnail-evidence");
    const fingerprint = "d".repeat(64);
    const asset = await prisma.visualAsset.create({
      data: {
        workspaceId: current.workspace.id,
        createdByUserId: current.user.id,
        title: "Frozen campaign thumbnail",
        kind: "image",
        storageKey: `fixtures/${randomUUID()}/thumbnail.jpg`,
        contentType: "image/jpeg",
        sizeBytes: 1_024n,
        width: 1_080,
        height: 1_920,
        fingerprint,
        provenance: "generated",
      },
    });
    const base = {
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      createdByUserId: current.user.id,
      clipId: current.clip.id,
      platform: "youtube_shorts" as const,
      status: "scheduled" as const,
      immutableRequestHash: "e".repeat(64),
      caption: "Approved fixture copy",
    };

    await expect(Promise.resolve(prisma.socialPost.create({
      data: {
        ...base,
        clientIdempotencyKey: randomUUID(),
        thumbnailAssetId: asset.id,
        thumbnailFingerprint: fingerprint,
      },
    }))).resolves.toMatchObject({
      thumbnailAssetId: asset.id,
      thumbnailFingerprint: fingerprint,
    });
    await expect(Promise.resolve(prisma.socialPost.create({
      data: {
        ...base,
        clientIdempotencyKey: randomUUID(),
        thumbnailAssetId: asset.id,
        thumbnailFingerprint: null,
      },
    }))).rejects.toBeDefined();
    await expect(Promise.resolve(prisma.socialPost.create({
      data: {
        ...base,
        clientIdempotencyKey: randomUUID(),
        thumbnailAssetId: null,
        thumbnailFingerprint: fingerprint,
      },
    }))).rejects.toBeDefined();
  });

  test("rejects nullable generated-media duration, quota, and insertion evidence", async () => {
    const current = await fixture("generated-media-evidence");
    const base = {
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      clipId: current.clip.id,
      actorUserId: current.user.id,
      ownerWorkspaceId: current.workspace.id,
      requestFingerprint: "1".repeat(64),
      provider: "fixture-provider",
	      model: "fixture-model",
	      promptFingerprint: "2".repeat(64),
	      promptKeyVersion: "test-primary",
      promptOriginKind: "manual",
      promptOriginSourceIds: [],
      aspectRatio: "9:16",
      style: "natural",
    };

    await expect(Promise.resolve(prisma.generatedMediaJob.create({
      data: {
        ...base,
        idempotencyKey: randomUUID(),
        kind: "video",
        durationSec: null,
      },
    }))).rejects.toBeDefined();
    await expect(Promise.resolve(prisma.generatedMediaJob.create({
      data: {
        ...base,
        idempotencyKey: randomUUID(),
        kind: "image",
        durationSec: null,
        insertionCount: 1,
        lastInsertionKind: null,
        lastInsertedAt: new Date(),
      },
    }))).rejects.toBeDefined();
		await expect(Promise.resolve(prisma.generatedMediaJob.create({
			data: {
				...base,
				idempotencyKey: randomUUID(),
				kind: "image",
				durationSec: null,
				promptKeyVersion: "",
			},
		}))).rejects.toBeDefined();
		const usageJob = await prisma.generatedMediaJob.create({
			data: {
				...base,
				idempotencyKey: randomUUID(),
				kind: "image",
				durationSec: null,
			},
		});
		const dayStart = new Date("2026-08-31T00:00:00.000Z");
		const dayEnd = new Date("2026-09-01T00:00:00.000Z");
		const usageBase = {
			jobId: usageJob.id,
			workspaceId: current.workspace.id,
			kind: "image",
			reservedUnits: 1,
			allowanceLimitUnits: 20,
			dailyAbuseLimitUnits: 40,
			dailyAbuseStartedAt: dayStart,
			dailyAbuseEndsAt: dayEnd,
		};
		await expect(Promise.resolve(prisma.generationUsageReservation.create({
			data: {
				...usageBase,
				usagePolicy: "metered",
				allowancePeriod: "calendar_day_utc",
				allowanceStartedAt: dayStart,
				allowanceEndsAt: null,
			},
		}))).rejects.toBeDefined();
		await expect(Promise.resolve(prisma.generationUsageReservation.create({
			data: {
				...usageBase,
				usagePolicy: "trial_metered",
				allowancePeriod: "calendar_day_utc",
				allowanceStartedAt: dayStart,
				allowanceEndsAt: dayEnd,
			},
		}))).rejects.toBeDefined();
  });

  test("settles duplicate and partial Render selected admission with stable item counts", async () => {
    const current = await fixture("render-selected");
    const missingClipId = randomUUID();
    let executions = 0;
    const execute = async (clipIds: string[]) => {
      executions += 1;
      return { workflowRunId: randomUUID(), acceptedAt: new Date().toISOString(), initialSeq: 1, clipCount: clipIds.length, variantCount: clipIds.length, resolution: "1080p" as const };
    };
    const request = {
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business" as const,
      idempotencyKey: randomUUID(),
      clipIds: [current.clip.id, missingClipId],
      resolution: "1080p" as const,
      execute,
    };
    const first = await campaignOperationService.renderSelected(request);
    const replay = await campaignOperationService.renderSelected(request);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(executions).toBe(1);
    const operation = await prisma.campaignOperation.findUniqueOrThrow({ where: { id: first.operationId }, include: { items: true } });
		expect(operation).toMatchObject({ requestedCount: 2, succeededCount: 1, ineligibleCount: 1, failedCount: 0, status: "partial" });
    expect(operation.items.map((item) => [item.requestedClipId, item.status, item.errorCode]).sort()).toEqual([
      [current.clip.id, "succeeded", null],
      [missingClipId, "ineligible", "campaign_clip_not_found"],
    ].sort());
  });

  test("applies selected motion with durable idempotency, revision fencing, and target eligibility", async () => {
    const current = await fixture("campaign-motion");
    const missingClipId = randomUUID();
    const idempotencyKey = randomUUID();
    const scope = {
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business" as const,
      role: "owner" as const,
      status: "active" as const,
      idempotencyKey,
    };
    const request = {
      change: {
        scope: "clip_transition" as const,
        transition: { type: "wipe-left" as const, durationSec: 0.55 },
      },
      clips: [
        { clipId: current.clip.id, expectedEditorRevision: 3 },
        { clipId: missingClipId, expectedEditorRevision: 0 },
      ],
    };

    const first = await campaignOperationService.applyMotionSelected(scope, request);
    const replay = await campaignOperationService.applyMotionSelected(scope, request);
    expect(first).toMatchObject({
      status: "partial",
      replayed: false,
      counts: { succeeded: 1, unchanged: 0, stale: 0, ineligible: 1, failed: 0 },
    });
    expect(replay).toMatchObject({ operationId: first.operationId, replayed: true });
    const operation = await prisma.campaignOperation.findUniqueOrThrow({
      where: { id: first.operationId },
      include: { items: true },
    });
    expect(operation.validatedOptions).toEqual({ change: request.change });
    expect(operation.items.map((item) => [item.requestedClipId, item.status, item.errorCode]).sort()).toEqual([
      [current.clip.id, "succeeded", null],
      [missingClipId, "ineligible", "campaign_clip_not_found"],
    ].sort());
    const afterTransition = await clipEditorDocumentPersistence.readDocument({
      actorUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
    });
    expect(afterTransition.revision).toBe(4);
    expect(afterTransition.document.studioEdits.transition).toEqual(request.change.transition);

    const equivalent = await campaignOperationService.applyMotionSelected(
      { ...scope, idempotencyKey: randomUUID() },
      {
        ...request,
        clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
      },
    );
    expect(equivalent.counts).toEqual({
      succeeded: 0,
      unchanged: 1,
      stale: 0,
      ineligible: 0,
      failed: 0,
    });
    const stale = await campaignOperationService.applyMotionSelected(
      { ...scope, idempotencyKey: randomUUID() },
      {
        change: {
          scope: "clip_transition",
          transition: { type: "zoom-in", durationSec: 0.4 },
        },
        clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
      },
    );
    expect(stale.counts.stale).toBe(1);

		const brollAsset = await prisma.visualAsset.create({
			data: {
				workspaceId: current.workspace.id,
				createdByUserId: current.user.id,
				title: "Campaign motion still",
				kind: "image",
				storageKey: `fixtures/${randomUUID()}/campaign-motion.png`,
				contentType: "image/png",
				sizeBytes: 64n,
				width: 1080,
				height: 1920,
				fingerprint: "a".repeat(64),
				provenance: "generated",
			},
		});
		const placementId = randomUUID();
		const withBroll = await clipEditorDocumentPersistence.mutateDocument({
      actorUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
			intent: {
				kind: "replace",
				baseRevision: afterTransition.revision,
				document: applyEditorAction(afterTransition.document, {
					type: "insertBrollPlacement",
					placement: {
						id: placementId,
						asset: {
							kind: "visual_asset",
							id: brollAsset.id,
							fingerprint: brollAsset.fingerprint,
						},
						provenance: "generated",
						mediaKind: "image",
						startSec: 1,
						endSec: 3,
						sourceStartSec: null,
						sourceEndSec: null,
					},
				}),
			},
    });
    const brollMotion = await campaignOperationService.applyMotionSelected(
      { ...scope, idempotencyKey: randomUUID() },
      {
        change: {
          scope: "manual_broll",
          motion: { entrance: "ken-burns-in", exit: "fade" },
        },
        clips: [{ clipId: current.clip.id, expectedEditorRevision: withBroll.revision }],
      },
    );
    expect(brollMotion.counts.succeeded).toBe(1);
    const afterBroll = await clipEditorDocumentPersistence.readDocument({
      actorUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
    });
    expect(afterBroll.document.mediaMotions).toEqual([
      expect.objectContaining({
			target: { kind: "broll", placementId },
        entrance: "ken-burns-in",
        exit: "fade",
      }),
    ]);
		const clearedBroll = await clipEditorDocumentPersistence.mutateDocument({
      actorUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
			intent: {
				kind: "replace",
				baseRevision: afterBroll.revision,
				document: applyEditorAction(afterBroll.document, {
					type: "deleteBrollPlacement",
					id: placementId,
				}),
			},
    });
    const staleMissingTarget = await campaignOperationService.applyMotionSelected(
      { ...scope, idempotencyKey: randomUUID() },
      {
        change: {
          scope: "manual_broll",
          motion: { entrance: "fade", exit: "none" },
        },
        clips: [{ clipId: current.clip.id, expectedEditorRevision: afterBroll.revision }],
      },
    );
    expect(staleMissingTarget.counts.stale).toBe(1);
    const ineligibleMissingTarget = await campaignOperationService.applyMotionSelected(
      { ...scope, idempotencyKey: randomUUID() },
      {
        change: {
          scope: "manual_broll",
          motion: { entrance: "fade", exit: "none" },
        },
        clips: [{ clipId: current.clip.id, expectedEditorRevision: clearedBroll.revision }],
      },
    );
    expect(ineligibleMissingTarget.counts.ineligible).toBe(1);

    await expect(
      campaignOperationService.applyMotionSelected(
        { ...scope, idempotencyKey, pricingTier: "creator" },
        request,
      ),
    ).rejects.toMatchObject({ code: "campaign_operation_feature_unavailable" });
    await expect(
      campaignOperationService.applyMotionSelected(
        { ...scope, idempotencyKey: randomUUID(), role: "viewer" },
        request,
      ),
    ).rejects.toMatchObject({ code: "campaign_operation_forbidden" });
    await expect(
      campaignOperationService.applyMotionSelected(scope, {
        ...request,
        change: {
          scope: "clip_transition",
          transition: { type: "fade", durationSec: 0.4 },
        },
      }),
    ).rejects.toMatchObject({ code: "campaign_operation_idempotency_conflict" });
  });

  test("applies the frozen Project Brand Profile and member styles through durable editor revisions", async () => {
    const current = await fixture("campaign-style");
    const profile = await prisma.brandProfile.create({
      data: {
        workspaceId: current.workspace.id,
        name: "Northstar",
        slug: `northstar-${randomUUID()}`,
        visualIdentity: {},
        voiceGuidance: {},
        createdByUserId: current.user.id,
        updatedByUserId: current.user.id,
      },
    });
    const firstStyle = await prisma.brandTemplate.create({
      data: {
        workspaceId: current.workspace.id,
        createdByUserId: current.user.id,
        name: "Launch captions",
        captionPreset: {
          ...DEFAULT_CAPTION_PRESET,
          fontName: "Archivo",
          primaryColor: "#F8FAFC",
          highlightColor: "#5B6CFF",
        },
        primaryColor: "#F8FAFC",
        secondaryColor: "#111522",
        accentColor: "#5B6CFF",
        profileMembership: { create: { profileId: profile.id, position: 0 } },
      },
    });
    const secondStyle = await prisma.brandTemplate.create({
      data: {
        workspaceId: current.workspace.id,
        createdByUserId: current.user.id,
        name: "Quiet captions",
        captionPreset: {
          ...DEFAULT_CAPTION_PRESET,
          fontName: "Arial",
          primaryColor: "#111522",
          highlightColor: "#F0B429",
        },
        primaryColor: "#FFFFFF",
        secondaryColor: "#111522",
        accentColor: "#F0B429",
        profileMembership: { create: { profileId: profile.id, position: 1 } },
      },
    });
    await prisma.brandProfile.update({
      where: { id: profile.id },
      data: { defaultTemplateId: firstStyle.id },
    });
    const frozenStyle = buildBrandTemplateSnapshot(firstStyle);
    const frozenProfile = buildBrandProfileSnapshot(profile, firstStyle);
    await prisma.project.update({
      where: { id: current.project.id },
      data: {
        brandProfileId: profile.id,
        brandTemplateId: firstStyle.id,
        brandProfileSnapshot: frozenProfile,
        brandSnapshot: frozenStyle,
      },
    });

    const initial = await clipEditorDocumentPersistence.readDocument({
      actorUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
    });
    const overridden = await clipEditorDocumentPersistence.mutateDocument({
      actorUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
      intent: {
        kind: "replace",
        baseRevision: initial.revision,
        document: applyEditorAction(initial.document, {
          type: "setStudioEdits",
          studioEdits: {
            ...initial.document.studioEdits,
            logo: {
              enabled: false,
              position: "top-left",
              opacity: 40,
              scalePct: 8,
            },
          },
        }),
      },
    });
    const scope = {
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      workspaceOwnerUserId: current.user.id,
      role: "owner" as const,
      status: "active" as const,
      pricingTier: "business" as const,
      isPersonalWorkspace: false,
      projectId: current.project.id,
      idempotencyKey: randomUUID(),
    };
    const catalog = await campaignOperationService.getEditorActionCatalog(scope);
    expect(catalog.profile).toMatchObject({
      id: profile.id,
      name: "Northstar",
      currentStyle: { id: firstStyle.id, name: "Launch captions" },
    });
    expect(catalog.styles.map((style) => style.id)).toEqual([
      firstStyle.id,
      secondStyle.id,
    ]);

    const missingClipId = randomUUID();
    const brandRequest = {
      profileFingerprint: catalog.profile!.fingerprint,
      styleFingerprint: catalog.profile!.styleFingerprint,
      clips: [
        { clipId: current.clip.id, expectedEditorRevision: overridden.revision },
        { clipId: missingClipId, expectedEditorRevision: 0 },
      ],
    };
    const brandPreview = await campaignOperationService.previewEditorAction(
      scope,
      { action: "apply_brand_profile", input: brandRequest },
    );
    expect(brandPreview.counts).toEqual({
      eligible: 1,
      unchanged: 0,
      stale: 0,
      ineligible: 1,
    });
    expect(brandPreview.items.map((item) => [item.clipId, item.status, item.code]).sort())
      .toEqual([
        [current.clip.id, "eligible", null],
        [missingClipId, "ineligible", "campaign_clip_not_found"],
      ].sort());
    const applied = await campaignOperationService.applyProjectBrandProfileSelected(
      scope,
      brandRequest,
    );
    const replay = await campaignOperationService.applyProjectBrandProfileSelected(
      scope,
      brandRequest,
    );
    expect(applied).toMatchObject({
      status: "partial",
      replayed: false,
      counts: {
        succeeded: 1,
        unchanged: 0,
        stale: 0,
        ineligible: 1,
        failed: 0,
      },
    });
    expect(replay).toMatchObject({ operationId: applied.operationId, replayed: true });
    const afterBrand = await clipEditorDocumentPersistence.readDocument({
      actorUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
    });
    expect(afterBrand.document.captionPreset.fontName).toBe("Archivo");
    expect(afterBrand.document.studioEdits.logo).toEqual({
      enabled: true,
      position: null,
      opacity: null,
      scalePct: null,
    });
    const brandOperation = await prisma.campaignOperation.findUniqueOrThrow({
      where: { id: applied.operationId },
      include: { items: true },
    });
    expect(brandOperation.validatedOptions).toMatchObject({
      profileId: profile.id,
      profileFingerprint: catalog.profile!.fingerprint,
      templateId: firstStyle.id,
      styleFingerprint: catalog.profile!.styleFingerprint,
    });
    expect(brandOperation.items.find((item) => item.clipId === current.clip.id)?.result)
      .toMatchObject({
        profileFingerprint: catalog.profile!.fingerprint,
        styleFingerprint: catalog.profile!.styleFingerprint,
      });

    const styleCatalog = catalog.styles.find((style) => style.id === secondStyle.id)!;
    const styleApplied = await campaignOperationService.applyStyleSelected(
      { ...scope, idempotencyKey: randomUUID() },
      {
        templateId: secondStyle.id,
        templateFingerprint: styleCatalog.fingerprint,
        clips: [{ clipId: current.clip.id, expectedEditorRevision: afterBrand.revision }],
      },
    );
    expect(styleApplied.counts.succeeded).toBe(1);
    const afterStyle = await clipEditorDocumentPersistence.readDocument({
      actorUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
    });
    expect(afterStyle.document.captionPreset).toMatchObject({
      fontName: "Arial",
      highlightColor: "#F0B429",
    });
    expect(afterStyle.document.studioEdits.logo).toEqual(
      afterBrand.document.studioEdits.logo,
    );

    const stale = await campaignOperationService.applyStyleSelected(
      { ...scope, idempotencyKey: randomUUID() },
      {
        templateId: firstStyle.id,
        templateFingerprint: catalog.styles[0]!.fingerprint,
        clips: [{ clipId: current.clip.id, expectedEditorRevision: afterBrand.revision }],
      },
    );
    expect(stale.counts.stale).toBe(1);
    const stalePreview = await campaignOperationService.previewEditorAction(
      scope,
      {
        action: "apply_style",
        input: {
          templateId: firstStyle.id,
          templateFingerprint: catalog.styles[0]!.fingerprint,
          clips: [{ clipId: current.clip.id, expectedEditorRevision: afterBrand.revision }],
        },
      },
    );
    expect(stalePreview.items).toEqual([
      expect.objectContaining({
        clipId: current.clip.id,
        status: "stale",
        currentEditorRevision: afterStyle.revision,
      }),
    ]);
    await expect(
      campaignOperationService.applyStyleSelected(
        { ...scope, idempotencyKey: randomUUID(), role: "viewer" },
        {
          templateId: firstStyle.id,
          templateFingerprint: catalog.styles[0]!.fingerprint,
          clips: [{ clipId: current.clip.id, expectedEditorRevision: afterStyle.revision }],
        },
      ),
    ).rejects.toMatchObject({ code: "campaign_operation_forbidden" });
    await expect(
      campaignOperationService.applyStyleSelected(
        { ...scope, idempotencyKey: randomUUID(), pricingTier: "creator" },
        {
          templateId: firstStyle.id,
          templateFingerprint: catalog.styles[0]!.fingerprint,
          clips: [{ clipId: current.clip.id, expectedEditorRevision: afterStyle.revision }],
        },
      ),
    ).rejects.toMatchObject({ code: "campaign_operation_feature_unavailable" });
  });

  test("freezes bundle revisions and variants while excluding stale and missing clips", async () => {
    const current = await fixture("bundle-freeze");
    const missingClipId = randomUUID();
    const bundleService = new CampaignOperationService(async ({ projectId, idempotencyKey, stage }) => prisma.workflowRun.create({ data: {
      projectId,
      idempotencyKey,
      stage,
      status: "queued",
      lifecycleVersion: 2,
    }, select: { id: true } }));
    const result = await bundleService.createExportBundle({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business",
      idempotencyKey: randomUUID(),
    }, {
      clips: [
        { clipId: current.clip.id, expectedEditorRevision: 3 },
        { clipId: missingClipId, expectedEditorRevision: 0 },
      ],
      aspectRatios: ["9:16", "1:1"],
      resolution: "1080p",
    });
    expect(result.manifest.included[0]).toMatchObject({ clipId: current.clip.id, editorRevision: 3 });
    expect(result.manifest.included[0]?.files.map((file) => file.variantId)).toEqual(current.clipExport.variants.map((variant) => variant.id));
    expect(result.manifest.excluded).toEqual([{ clipId: missingClipId, code: "campaign_clip_not_found" }]);
    expect(JSON.stringify(result.manifest)).not.toContain("http");

    await prisma.clip.update({ where: { id: current.clip.id }, data: { editorRevision: 4 } });
    await expect(bundleService.createExportBundle({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business",
      idempotencyKey: randomUUID(),
    }, { clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }], aspectRatios: ["9:16"], resolution: "1080p" })).rejects.toMatchObject({ code: "export_bundle_empty" });

    const exactRevision = await fixture("bundle-exact-export-revision");
    await prisma.clipExport.update({ where: { id: exactRevision.clipExport.id }, data: { editorRevision: 2 } });
    await expect(bundleService.createExportBundle({
      actorUserId: exactRevision.user.id,
      workspaceId: exactRevision.workspace.id,
      projectId: exactRevision.project.id,
      pricingTier: "business",
      idempotencyKey: randomUUID(),
    }, { clips: [{ clipId: exactRevision.clip.id, expectedEditorRevision: 3 }], aspectRatios: ["9:16"], resolution: "1080p" })).rejects.toMatchObject({ code: "export_bundle_empty" });
  });

	test("retries an export bundle admission failure by source operation", async () => {
		const current = await fixture("bundle-admission-retry");
		const sourceKey = randomUUID();
		const failing = new CampaignOperationService(async () => {
			throw new Error("injected_bundle_admission_failure");
		});
		await expect(failing.createExportBundle({
			actorUserId: current.user.id,
			workspaceId: current.workspace.id,
			projectId: current.project.id,
			pricingTier: "business",
			idempotencyKey: sourceKey,
		}, {
			clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
			aspectRatios: ["9:16"],
			resolution: "1080p",
		})).rejects.toThrow("injected_bundle_admission_failure");
		const source = await prisma.campaignOperation.findUniqueOrThrow({
			where: { workspaceId_projectId_action_idempotencyKey: {
				workspaceId: current.workspace.id,
				projectId: current.project.id,
				action: "export_bundle",
				idempotencyKey: sourceKey,
			} },
			include: { bundle: true, items: true },
		});
		expect(source.bundle).toBeNull();
		expect(source.items[0]).toMatchObject({ status: "failed", errorCode: "export_bundle_admission_failed" });

		const succeeding = new CampaignOperationService(async ({ projectId, idempotencyKey, stage }) => prisma.workflowRun.create({
			data: { projectId, idempotencyKey, stage, status: "queued", lifecycleVersion: 2 },
			select: { id: true },
		}));
		const retried = await succeeding.retryExportBundleOperation({
			actorUserId: current.user.id,
			workspaceId: current.workspace.id,
			projectId: current.project.id,
			pricingTier: "business",
			idempotencyKey: randomUUID(),
		}, source.id);
		const retry = await prisma.campaignOperation.findUniqueOrThrow({ where: { id: retried.operationId } });
		expect(retry.retryOfId).toBe(source.id);
		expect(retried.manifest.included.map((item) => item.clipId)).toEqual([current.clip.id]);
	});

  test("allows only one concurrent retry and selects failed admission items", async () => {
    const current = await fixture("campaign-retry");
    const source = await prisma.campaignOperation.create({ data: {
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      actorUserId: current.user.id,
      action: "render_selected",
      idempotencyKey: randomUUID(),
      requestFingerprint: randomUUID(),
			validatedOptions: { aspectRatios: [], resolution: "1080p" },
			pricingTier: "business",
      status: "failed",
      requestedCount: 1,
      failedCount: 1,
      items: { create: { itemKey: current.clip.id, requestedClipId: current.clip.id, clipId: current.clip.id, expectedEditorRevision: 3, status: "failed", errorCode: "campaign_render_admission_failed" } },
    } });
    const execute = async (clipIds: string[]) => ({ workflowRunId: randomUUID(), acceptedAt: new Date().toISOString(), initialSeq: 1, clipCount: clipIds.length, variantCount: 1, resolution: "1080p" as const });
    const outcomes = await Promise.allSettled([0, 1].map(() => campaignOperationService.retryRenderSelected({
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business",
      sourceOperationId: source.id,
      idempotencyKey: randomUUID(),
      resolution: "1080p",
      execute,
    })));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => (outcome as PromiseRejectedResult).reason)).toEqual([expect.any(CampaignOperationError)]);
    expect(await prisma.campaignOperation.count({ where: { retryOfId: source.id } })).toBe(1);
  });

	test("persists only the selected Facebook Page and consumes the selection once", async () => {
		const current = await fixture("facebook-page-selection");
		const state = randomUUID().replaceAll("-", "");
		await prisma.socialOAuthState.create({ data: {
			userId: current.user.id,
			workspaceId: current.workspace.id,
			createdByUserId: current.user.id,
			platform: "facebook_reels",
			state,
			redirectPath: "/settings/social",
			expiresAt: new Date(Date.now() + 15 * 60_000),
		} });
		const originalFetch = globalThis.fetch;
		const responses = [
			new Response(JSON.stringify({ access_token: "short-token", scope: "pages_show_list,pages_read_engagement,pages_manage_posts" }), { status: 200 }),
			new Response(JSON.stringify({ access_token: "long-token", expires_in: 3600 }), { status: 200 }),
			new Response(JSON.stringify({ data: [
				{ permission: "pages_show_list", status: "granted" },
				{ permission: "pages_read_engagement", status: "granted" },
				{ permission: "pages_manage_posts", status: "granted" },
			] }), { status: 200 }),
			new Response(JSON.stringify({ data: [
				{ id: "page-a", name: "Page A", access_token: "page-token-a", tasks: ["CREATE_CONTENT"] },
				{ id: "page-b", name: "Page B", access_token: "page-token-b", tasks: ["CREATE_CONTENT"] },
			] }), { status: 200 }),
		];
		globalThis.fetch = async () => responses.shift() ?? new Response(null, { status: 500 });
		try {
			const callback = await socialOAuthService.handleCallback({ state, code: "provider-code", origin: "https://app.example.test" });
			expect(callback.facebookSelectionToken).toBe(state);
			await expect(socialOAuthService.getFacebookPageSelection(current.user.id, randomUUID(), state)).rejects.toMatchObject({ code: "social_facebook_selection_invalid" });
			expect(await socialOAuthService.getFacebookPageSelection(current.user.id, current.workspace.id, state)).toEqual([
				{ id: "page-a", name: "Page A", avatarUrl: null },
				{ id: "page-b", name: "Page B", avatarUrl: null },
			]);
			await prisma.socialOAuthState.update({ where: { state }, data: { expiresAt: new Date(Date.now() - 1_000) } });
			await expect(socialOAuthService.getFacebookPageSelection(current.user.id, current.workspace.id, state)).rejects.toMatchObject({ code: "social_facebook_selection_invalid" });
			await prisma.socialOAuthState.update({ where: { state }, data: { expiresAt: new Date(Date.now() + 15 * 60_000) } });
			const selected = await socialOAuthService.completeFacebookPageSelection(current.user.id, current.workspace.id, state, "page-b");
			expect(selected).toMatchObject({ platform: "facebook_reels", providerAccountId: "page-b", displayName: "Page B" });
			await expect(socialOAuthService.completeFacebookPageSelection(current.user.id, current.workspace.id, state, "page-a")).rejects.toMatchObject({ code: "social_facebook_selection_invalid" });
			expect(await prisma.socialAccount.findMany({ where: { userId: current.user.id, platform: "facebook_reels" }, select: { providerAccountId: true } })).toEqual([{ providerAccountId: "page-b" }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

  test("pauses Review seams without corrupting a durable round and resumes delivery", async () => {
    const current = await fixture("review-rollout");
    await prisma.user.update({
      where: { id: current.user.id },
      data: { emailVerifiedAt: new Date() },
    });
    const rolloutEnv: Record<string, string | undefined> = {
      NARRIFLOW_WRITES_REVIEW_ROOMS: "1",
      NARRIFLOW_READS_REVIEW_GUEST: "1",
      NARRIFLOW_WRITES_REVIEW_FEEDBACK: "1",
      NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS: "0",
    };
    const service = new ReviewService(createReviewRolloutPolicy(rolloutEnv));
    const variant = current.clipExport.variants[0]!;
    const dataSecret = "d".repeat(64);
    const created = await service.createRound(
      {
        actorUserId: current.user.id,
        workspaceId: current.workspace.id,
        projectId: current.project.id,
        pricingTier: "business",
      },
      {
        title: "Durable staged round",
        message: null,
        passcode: null,
        expiresAt: null,
        allowDownloads: false,
        approvalRequired: true,
        recipientEmails: ["client@example.test"],
        sourceRoundId: null,
        items: [{
          clipId: current.clip.id,
          exportId: current.clipExport.id,
          expectedEditorRevision: 3,
          variantIds: [variant.id],
          required: true,
        }],
      },
      { accessSecret: "a".repeat(64), dataSecret },
    );

    expect(created.notificationIds).toEqual([]);
    expect(await prisma.campaignOperation.findFirst({
      where: {
        workspaceId: current.workspace.id,
        projectId: current.project.id,
        action: "create_review",
        idempotencyKey: created.id,
      },
      select: {
        status: true,
        requestedCount: true,
        succeededCount: true,
        items: {
          select: {
            requestedClipId: true,
            expectedEditorRevision: true,
            exportId: true,
            status: true,
            result: true,
          },
        },
      },
    })).toEqual({
      status: "completed",
      requestedCount: 1,
      succeededCount: 1,
      items: [{
        requestedClipId: current.clip.id,
        expectedEditorRevision: 3,
        exportId: current.clipExport.id,
        status: "succeeded",
        result: {
          reviewRoundId: created.id,
          exportId: current.clipExport.id,
          selectedVariantCount: 1,
        },
      }],
    });
    expect(await prisma.reviewNotification.count({
      where: { reviewRoundId: created.id },
    })).toBe(0);
    expect(await prisma.reviewAuditEvent.count({
      where: {
        reviewRoundId: created.id,
        kind: "notification_admission_suppressed",
      },
    })).toBe(1);

    const session = await service.authenticate(
      created.token,
      { identity: "Client", email: "client@example.test", passcode: null },
      "203.0.113.20",
      sessionSecret,
    );
    const snapshot = await service.readRound(session, sessionSecret);
    const item = snapshot.round.items[0]!;
    const comment = await service.addComment(session, sessionSecret, {
      itemId: item.id,
      parentId: null,
      body: "Keep this feedback through the pause.",
      timestampSec: null,
    });
    await service.decide(session, sessionSecret, {
      itemId: item.id,
      decision: "changes_requested",
      reason: "Revise the opening.",
    });
    const reviewer = await prisma.reviewRecipient.findFirstOrThrow({
      where: { reviewRoundId: created.id, role: "reviewer" },
      select: { id: true },
    });
    const internal = await service.addInternalComment(
      {
        actorUserId: current.user.id,
        workspaceId: current.workspace.id,
        projectId: current.project.id,
      },
      created.id,
      {
        itemId: item.id,
        parentId: comment.id,
        body: "We will revise this.",
        timestampSec: null,
        mentionRecipientIds: [reviewer.id],
      },
    );
    expect(internal.notificationIds).toEqual([]);
    expect(await prisma.reviewNotification.count({
      where: { reviewRoundId: created.id },
    })).toBe(0);

    const preservedBeforePause = {
      rounds: await prisma.reviewRound.count({ where: { id: created.id } }),
      guests: await prisma.reviewGuest.count({
        where: { reviewRoundId: created.id },
      }),
      comments: await prisma.reviewComment.count({
        where: { reviewRoundId: created.id },
      }),
      decisions: await prisma.reviewDecision.count({
        where: { reviewRoundId: created.id },
      }),
    };
    rolloutEnv.NARRIFLOW_READS_REVIEW_GUEST = "0";
    await expect(service.readRound(session, sessionSecret)).rejects.toMatchObject({
      code: "review_access_temporarily_unavailable",
      message: "Review access is temporarily unavailable",
    });
    expect({
      rounds: await prisma.reviewRound.count({ where: { id: created.id } }),
      guests: await prisma.reviewGuest.count({
        where: { reviewRoundId: created.id },
      }),
      comments: await prisma.reviewComment.count({
        where: { reviewRoundId: created.id },
      }),
      decisions: await prisma.reviewDecision.count({
        where: { reviewRoundId: created.id },
      }),
    }).toEqual(preservedBeforePause);

    rolloutEnv.NARRIFLOW_READS_REVIEW_GUEST = "1";
    expect((await service.readRound(session, sessionSecret)).round.id).toBe(
      created.id,
    );
    rolloutEnv.NARRIFLOW_WRITES_REVIEW_FEEDBACK = "0";
    await expect(service.addComment(session, sessionSecret, {
      itemId: item.id,
      parentId: null,
      body: "Blocked while feedback is paused.",
      timestampSec: null,
    })).rejects.toMatchObject({
      code: "review_feedback_temporarily_unavailable",
    });
    expect((await service.readRound(session, sessionSecret)).round.comments)
      .toHaveLength(preservedBeforePause.comments);

    rolloutEnv.NARRIFLOW_WRITES_REVIEW_ROOMS = "0";
    await expect(service.createRound(
      {
        actorUserId: current.user.id,
        workspaceId: current.workspace.id,
        projectId: current.project.id,
        pricingTier: "business",
      },
      {},
    )).rejects.toMatchObject({ code: "program_write_disabled" });
    expect((await service.readRound(session, sessionSecret)).round.id).toBe(
      created.id,
    );

    await expect(service.resendRound(
      {
        actorUserId: current.user.id,
        workspaceId: current.workspace.id,
        projectId: current.project.id,
      },
      created.id,
      randomUUID(),
    )).rejects.toMatchObject({
      code: "review_notifications_temporarily_unavailable",
    });
    rolloutEnv.NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS = "1";
    const resent = await service.resendRound(
      {
        actorUserId: current.user.id,
        workspaceId: current.workspace.id,
        projectId: current.project.id,
      },
      created.id,
      randomUUID(),
    );
    expect(resent.notificationIds).toHaveLength(1);
    expect(await prisma.reviewNotification.count({
      where: { reviewRoundId: created.id },
    })).toBe(1);
  });

  test("rate limits valid guest credentials before updating reviewer identity", async () => {
    const current = await fixture("review-valid-access-rate-limit");
    const variant = current.clipExport.variants[0]!;
    const passcode = "bounded-review-passcode";
    const email = "bounded-reviewer@example.test";
    const source = "203.0.113.30";
    const created = await reviewService.createRound(
      {
        actorUserId: current.user.id,
        workspaceId: current.workspace.id,
        projectId: current.project.id,
        pricingTier: "business",
      },
      {
        title: "Rate-limited client round",
        message: null,
        passcode,
        expiresAt: null,
        allowDownloads: false,
        approvalRequired: true,
        items: [{
          clipId: current.clip.id,
          exportId: current.clipExport.id,
          expectedEditorRevision: 3,
          variantIds: [variant.id],
          required: true,
        }],
      },
    );

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await expect(reviewService.authenticate(
        created.token,
        {
          identity: `Approved reviewer ${attempt}`,
          email,
          passcode,
        },
        source,
        sessionSecret,
      )).resolves.toBeString();
    }

    const rejectedIdentity = "Must never reach durable state";
    const error = await reviewService.authenticate(
      created.token,
      { identity: rejectedIdentity, email, passcode },
      source,
      sessionSecret,
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ReviewServiceError);
    expect(error).toMatchObject({
      code: "review_access_rate_limited",
      message: "Too many review access attempts",
    });
    for (const privateValue of [
      created.token,
      created.id,
      current.project.id,
      rejectedIdentity,
      email,
      passcode,
      source,
    ]) {
      expect(`${error.name}:${error.message}:${JSON.stringify(error)}`).not
        .toContain(privateValue);
    }
    expect(await prisma.reviewGuest.findMany({
      where: { reviewRoundId: created.id },
      select: { displayName: true },
    })).toEqual([{ displayName: "Approved reviewer 8" }]);
  });

  test("revokes replayed guest sessions, isolates media IDs, and serializes opposite decisions", async () => {
    const current = await fixture("review-security");
    const foreign = await fixture("review-foreign");
    const variant = current.clipExport.variants[0]!;
    const created = await reviewService.createRound({ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" }, {
      title: "Client round",
      message: null,
      passcode: "review-secret",
      expiresAt: null,
      allowDownloads: false,
      approvalRequired: true,
      items: [{ clipId: current.clip.id, exportId: current.clipExport.id, expectedEditorRevision: 3, variantIds: [variant.id], required: true }],
    });
    const invalidAccess = await reviewService.authenticate(created.token, { identity: "Client", email: "client@example.test", passcode: "wrong-passcode" }, "203.0.113.10", sessionSecret).catch((caught) => caught);
    expect(invalidAccess).toMatchObject({
      code: "review_access_invalid",
      message: "Review access is invalid or expired",
    });
    for (const privateValue of [created.token, created.id, current.project.id, "wrong-passcode", "client@example.test"]) {
      expect(`${invalidAccess.name}:${invalidAccess.message}:${JSON.stringify(invalidAccess)}`).not.toContain(privateValue);
    }
    const firstSession = await reviewService.authenticate(created.token, { identity: "Client", email: "client@example.test", passcode: "review-secret" }, "203.0.113.10", sessionSecret);
    const secondSession = await reviewService.authenticate(created.token, { identity: "Client updated", email: "CLIENT@example.test", passcode: "review-secret" }, "203.0.113.10", sessionSecret);
		const additionalSessions = [];
		for (let index = 0; index < 1; index += 1) {
			additionalSessions.push(await reviewService.authenticate(created.token, { identity: `Reviewer ${index + 1}`, email: `reviewer-${index + 1}@example.test`, passcode: "review-secret" }, "203.0.113.10", sessionSecret));
		}
		expect(additionalSessions).toHaveLength(1);
    await expect(reviewService.readRound(firstSession, sessionSecret)).rejects.toMatchObject({ code: "review_session_invalid" });
    const snapshot = await reviewService.readRound(secondSession, sessionSecret);
    const item = snapshot.round.items[0]!;
    await expect(reviewService.resolveMedia(secondSession, sessionSecret, item.id, foreign.clipExport.variants[0]!.id)).rejects.toMatchObject({ code: "review_media_not_found" });
    await expect(reviewService.resolveMedia(secondSession, sessionSecret, item.id, variant.id, "download")).rejects.toMatchObject({ code: "review_download_forbidden" });
    await expect(reviewService.addComment(secondSession, sessionSecret, { itemId: null, parentId: null, body: "Impossible round timecode", timestampSec: 1 })).rejects.toMatchObject({ code: "review_timecode_requires_item" });
    await expect(reviewService.addComment(secondSession, sessionSecret, { itemId: item.id, parentId: null, body: "Past the frozen export", timestampSec: 11 })).rejects.toMatchObject({ code: "review_timecode_out_of_range" });
		const parentComment = await reviewService.addComment(secondSession, sessionSecret, { itemId: item.id, parentId: null, body: "At the exact end", timestampSec: 10 });
		const concurrentEdits = await Promise.all([
			reviewService.editComment(secondSession, sessionSecret, parentComment.id, { body: "Edit from browser A" }),
			reviewService.editComment(secondSession, sessionSecret, parentComment.id, { body: "Edit from browser B" }),
		]);
		expect(concurrentEdits).toHaveLength(2);
		expect(["Edit from browser A", "Edit from browser B"]).toContain((await prisma.reviewComment.findUniqueOrThrow({ where: { id: parentComment.id } })).body);
		const concurrentResolution = await Promise.all([
			reviewService.resolveComment({ workspaceId: current.workspace.id, projectId: current.project.id, actorUserId: current.user.id }, created.id, parentComment.id, true),
			reviewService.resolveComment({ workspaceId: current.workspace.id, projectId: current.project.id, actorUserId: current.user.id }, created.id, parentComment.id, false),
		]);
		expect(concurrentResolution).toHaveLength(2);
		expect(await prisma.reviewAuditEvent.count({ where: { reviewRoundId: created.id, targetId: parentComment.id, kind: { in: ["comment_edited", "comment_resolved", "comment_reopened"] } } })).toBe(4);
		const auditPayload = JSON.stringify(await prisma.reviewAuditEvent.findMany({ where: { reviewRoundId: created.id } }));
		for (const secretValue of [created.token, "review-secret", "Client updated", "client@example.test", parentComment.body, "https://review.example/private"]) {
			expect(auditPayload).not.toContain(secretValue);
		}
		const reply = await reviewService.addComment(additionalSessions[0]!, sessionSecret, { itemId: item.id, parentId: parentComment.id, body: "Reply", timestampSec: null });
		await expect(reviewService.deleteComment(secondSession, sessionSecret, parentComment.id)).rejects.toMatchObject({ code: "review_comment_has_replies" });
		await expect(reviewService.deleteComment(additionalSessions[0]!, sessionSecret, reply.id)).resolves.toEqual({ deleted: true });
		await expect(reviewService.deleteComment(secondSession, sessionSecret, parentComment.id)).resolves.toEqual({ deleted: true });

    const decisions = await Promise.all([
      reviewService.decide(secondSession, sessionSecret, { itemId: item.id, decision: "approved", reason: null }),
      reviewService.decide(secondSession, sessionSecret, { itemId: item.id, decision: "changes_requested", reason: "Tighten the opening" }),
    ]);
    expect(decisions).toHaveLength(2);
    expect(await prisma.reviewDecision.count({ where: { reviewRoundId: created.id } })).toBe(2);
    expect(await prisma.reviewDecision.count({ where: { reviewRoundId: created.id, supersededAt: null } })).toBe(1);
		for (let attempt = 0; attempt < 7; attempt += 1) {
			await expect(reviewService.authenticate(created.token, { identity: "Attacker", email: "attacker@example.test", passcode: "wrong-passcode" }, "203.0.113.10", sessionSecret)).rejects.toMatchObject({ code: "review_access_invalid" });
		}
		await expect(reviewService.authenticate(created.token, { identity: "Attacker", email: "attacker@example.test", passcode: "wrong-passcode" }, "203.0.113.10", sessionSecret)).rejects.toMatchObject({ code: "review_access_rate_limited" });
		await prisma.reviewRound.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
		await expect(reviewService.readRound(secondSession, sessionSecret)).rejects.toBeInstanceOf(ReviewServiceError);
		await prisma.reviewRound.update({ where: { id: created.id }, data: { expiresAt: null } });
		await reviewService.revokeRound({ workspaceId: current.workspace.id, projectId: current.project.id, actorUserId: current.user.id }, created.id);
    await expect(reviewService.readRound(secondSession, sessionSecret)).rejects.toBeInstanceOf(ReviewServiceError);
  });

  test("allocates concurrent review revisions and freezes scene-template insertion", async () => {
    const current = await fixture("review-revisions-scenes");
    const variant = current.clipExport.variants[0]!;
    const input = (title: string) => ({
      title,
      message: null,
      passcode: null,
      expiresAt: null,
      allowDownloads: true,
      approvalRequired: false,
      items: [{ clipId: current.clip.id, exportId: current.clipExport.id, expectedEditorRevision: 3, variantIds: [variant.id], required: true }],
    });
    const rounds = await Promise.all([
      reviewService.createRound({ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" }, input("Round A")),
      reviewService.createRound({ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" }, input("Round B")),
    ]);
    expect(rounds.map((round) => round.revision).sort()).toEqual([1, 2]);
    expect(await prisma.reviewRound.count({ where: { projectId: current.project.id, status: "open" } })).toBe(1);
		const resubmitted = await reviewService.createRound(
			{ actorUserId: current.user.id, workspaceId: current.workspace.id, projectId: current.project.id, pricingTier: "business" },
			input("Round C"),
		);
		expect(resubmitted.revision).toBe(3);
		expect(rounds.map((round) => round.token)).not.toContain(resubmitted.token);
		expect(await prisma.reviewRound.count({ where: { projectId: current.project.id, status: "open" } })).toBe(1);

    const profile = await prisma.brandProfile.create({ data: {
      workspaceId: current.workspace.id,
      name: "Launch system",
      slug: `launch-${randomUUID()}`,
      visualIdentity: {},
      voiceGuidance: {},
      createdByUserId: current.user.id,
      updatedByUserId: current.user.id,
    } });
    const scope = { actorUserId: current.user.id, workspaceId: current.workspace.id, workspaceOwnerUserId: current.user.id, role: "owner" as const, status: "active" as const, pricingTier: "business" as const, isPersonalWorkspace: false };
    const retainedAsset = await prisma.visualAsset.create({
      data: {
        workspaceId: current.workspace.id,
        createdByUserId: current.user.id,
        title: "Retained opener",
        kind: "image",
        storageKey: `test/retained-${randomUUID()}.png`,
        contentType: "image/png",
        sizeBytes: 128,
        width: 1080,
        height: 1080,
        fingerprint: "c".repeat(64),
        deletedAt: new Date(),
      },
    });
    const retainedScene = editorDocumentSchema.parse({
      version: 2,
      clipStartSec: 0,
      clipEndSec: 10,
      captionPreset: {},
      transcriptSlice: [],
      studioEdits: {},
      brollUrl: null,
      deletedRanges: [],
      sceneBlocks: [{
        id: randomUUID(),
        schemaVersion: 1,
        anchorSec: 0,
        durationSec: 2,
        content: {
          kind: "image",
          asset: { kind: "visual_asset", id: retainedAsset.id, fingerprint: retainedAsset.fingerprint },
          fit: "cover",
          backgroundColor: "#000000",
        },
        motion: { entrance: "none", exit: "none" },
        templateSnapshot: null,
      }],
    }).sceneBlocks;
    await expect(
      visualAssetService.assertSceneReferencesWithPolicy(scope, retainedScene, true),
    ).resolves.toBeUndefined();
    await expect(
      visualAssetService.assertSceneReferences(scope, retainedScene),
    ).rejects.toMatchObject({ code: "scene_visual_asset_invalid" });
    const sourceFont = await prisma.brandFont.create({
      data: {
        workspaceId: current.workspace.id,
        licenseConfirmedByUserId: current.user.id,
        family: "Launch Display",
        style: "Regular",
        weight: 400,
        format: "ttf",
        storageKey: `test/font-${randomUUID()}.ttf`,
        sizeBytes: 128,
        fingerprint: "d".repeat(64),
        licenseConfirmedAt: new Date(),
        profiles: { create: { profileId: profile.id, role: "display" } },
      },
    });
    const replacementFont = await prisma.brandFont.create({
      data: {
        workspaceId: current.workspace.id,
        licenseConfirmedByUserId: current.user.id,
        family: "Launch Display Next",
        style: "Regular",
        weight: 400,
        format: "ttf",
        storageKey: `test/font-${randomUUID()}.ttf`,
        sizeBytes: 128,
        fingerprint: "e".repeat(64),
        licenseConfirmedAt: new Date(),
      },
    });
    const fontTemplate = await sceneTemplateService.create(scope, profile.id, {
      name: "Font-protected card",
      role: "inline",
      makeDefault: false,
      definition: {
        schemaVersion: 1,
        durationSec: 3,
        content: {
          kind: "text",
          text: "Protected typography",
          fontFamily: sourceFont.family,
          fontAsset: { kind: "brand_font", id: sourceFont.id, fingerprint: sourceFont.fingerprint },
          color: "#FFFFFF",
          backgroundColor: "#111827",
        },
        motion: { entrance: "fade", exit: "fade" },
      },
    });
    await expect(
      brandFontService.softDelete(scope, sourceFont.id, { replacementId: replacementFont.id }),
    ).rejects.toBeInstanceOf(BrandFontReferenceError);
    await prisma.sceneTemplate.update({
      where: { id: fontTemplate.id },
      data: { deletedAt: new Date() },
    });
    const template = await sceneTemplateService.create(scope, profile.id, {
      name: "Opening card",
      role: "intro",
      makeDefault: true,
      definition: { schemaVersion: 1, durationSec: 3, content: { kind: "text", text: "Launch day", fontFamily: "Arial", fontAsset: null, color: "#FFFFFF", backgroundColor: "#111827" }, motion: { entrance: "fade", exit: "fade" } },
    });
    const frozen = await sceneTemplateService.freezeForInsertion(scope, profile.id, template.id, { id: randomUUID(), anchorSec: 0 });
    await sceneTemplateService.update(scope, profile.id, template.id, { expectedRevision: template.revision, definition: { schemaVersion: 1, durationSec: 3, content: { kind: "text", text: "Changed later", fontFamily: "Arial", fontAsset: null, color: "#FFFFFF", backgroundColor: "#111827" }, motion: { entrance: "fade", exit: "fade" } } });
    expect(frozen.content).toMatchObject({ kind: "text", text: "Launch day" });
		const document = editorDocumentSchema.parse({ version: 2, clipStartSec: 0, clipEndSec: 10, captionPreset: {}, transcriptSlice: [], studioEdits: {}, brollUrl: null, deletedRanges: [] });
    const once = applyEditorAction(document, { type: "insertSceneBlock", scene: frozen });
    const twice = applyEditorAction(once, { type: "insertSceneBlock", scene: { ...frozen, id: randomUUID() } });
    expect(twice).toBe(once);

    const latestTemplate = await prisma.sceneTemplate.findUniqueOrThrow({ where: { id: template.id } });
    const scenePreview = await campaignOperationService.previewEditorAction(
      { ...scope, projectId: current.project.id },
      {
        action: "apply_scene_template",
        profileId: profile.id,
        templateId: template.id,
        input: {
          templateFingerprint: latestTemplate.fingerprint,
          placement: "start",
          clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
        },
      },
    );
    expect(scenePreview.counts).toEqual({
      eligible: 1,
      unchanged: 0,
      stale: 0,
      ineligible: 0,
    });
    const applied = await campaignOperationService.applySceneTemplate({
      ...scope,
      projectId: current.project.id,
      idempotencyKey: randomUUID(),
    }, profile.id, template.id, {
      templateFingerprint: latestTemplate.fingerprint,
      placement: "start",
      clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
    });
    expect(applied.counts).toEqual({ succeeded: 1, unchanged: 0, stale: 0, ineligible: 0, failed: 0 });
    const reapplied = await campaignOperationService.applySceneTemplate({
      ...scope,
      projectId: current.project.id,
      idempotencyKey: randomUUID(),
    }, profile.id, template.id, {
      templateFingerprint: latestTemplate.fingerprint,
      placement: "start",
      clips: [{ clipId: current.clip.id, expectedEditorRevision: 4 }],
    });
    expect(reapplied.counts).toEqual({ succeeded: 0, unchanged: 1, stale: 0, ineligible: 0, failed: 0 });
    const equivalentPreview = await campaignOperationService.previewEditorAction(
      { ...scope, projectId: current.project.id },
      {
        action: "apply_scene_template",
        profileId: profile.id,
        templateId: template.id,
        input: {
          templateFingerprint: latestTemplate.fingerprint,
          placement: "start",
          clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
        },
      },
    );
    expect(equivalentPreview.counts.unchanged).toBe(1);
    const persisted = await clipEditorDocumentPersistence.readDocument({ actorUserId: current.user.id, projectId: current.project.id, clipId: current.clip.id });
    expect(persisted.document.sceneBlocks).toHaveLength(1);

    const appliedAtEnd = await campaignOperationService.applySceneTemplate({
      ...scope,
      projectId: current.project.id,
      idempotencyKey: randomUUID(),
    }, profile.id, template.id, {
      templateFingerprint: latestTemplate.fingerprint,
      placement: "end",
      clips: [{ clipId: current.clip.id, expectedEditorRevision: persisted.revision }],
    });
    expect(appliedAtEnd.counts.succeeded).toBe(1);
    const afterEnd = await clipEditorDocumentPersistence.readDocument({ actorUserId: current.user.id, projectId: current.project.id, clipId: current.clip.id });
    const reappliedAtEnd = await campaignOperationService.applySceneTemplate({
      ...scope,
      projectId: current.project.id,
      idempotencyKey: randomUUID(),
    }, profile.id, template.id, {
      templateFingerprint: latestTemplate.fingerprint,
      placement: "end",
      clips: [{ clipId: current.clip.id, expectedEditorRevision: afterEnd.revision }],
    });
    expect(reappliedAtEnd.counts.unchanged).toBe(1);
    const finalDocument = await clipEditorDocumentPersistence.readDocument({ actorUserId: current.user.id, projectId: current.project.id, clipId: current.clip.id });
    expect(finalDocument.document.sceneBlocks).toHaveLength(2);
    const frozenBrollPlacement = {
      id: randomUUID(),
      asset: {
        kind: "visual_asset" as const,
        id: retainedAsset.id,
        fingerprint: retainedAsset.fingerprint,
      },
      provenance: "generated" as const,
      mediaKind: "image" as const,
      startSec: 2,
      endSec: 5,
      sourceStartSec: null,
      sourceEndSec: null,
    };
    const documentWithBroll = editorDocumentSchema.parse({
      ...finalDocument.document,
      brollPlacements: [frozenBrollPlacement],
    });
    const persistedBroll = await clipEditorDocumentPersistence.mutateDocument({
      actorUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
      intent: {
        kind: "replace",
        baseRevision: finalDocument.revision,
        document: documentWithBroll,
      },
    });
    const createdExport = await clipExportService.create(
      current.project.id,
      current.clip.id,
      { expectedRevision: persistedBroll.revision, aspectRatios: ["9:16"], resolution: "1080p" },
      randomUUID(),
      { workspaceId: current.workspace.id, actorUserId: current.user.id },
    );
    const render = await prisma.clipRender.findFirstOrThrow({
      where: { exportVariant: { exportId: createdExport.export.id } },
      select: { clipSnapshot: true },
    });
    expect(Reflect.get(render.clipSnapshot as object, "editorDocumentVersion")).toBe(2);
    expect(Reflect.get(render.clipSnapshot as object, "sceneBlocks")).toHaveLength(2);
    expect(Reflect.get(render.clipSnapshot as object, "brollPlacements")).toEqual([
      frozenBrollPlacement,
    ]);
  });
});
