import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { editorDocumentSchema, applyEditorAction } from "@narriflow/validators";
import { Pool } from "pg";
import { CampaignOperationError, CampaignOperationService, campaignOperationService } from "./campaign-operation.service";
import { clipEditorDocumentPersistence } from "./clip-editor-document-persistence";
import { ReviewServiceError, reviewService } from "./review.service";
import { sceneTemplateService } from "./scene-template.service";
import { socialOAuthService } from "./social-oauth.service";
import { visualAssetService } from "./visual-asset.service";
import { BrandFontReferenceError, brandFontService } from "./brand-font.service";
import { clipExportService } from "./clip-export.service";

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
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined) });
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

  test("persists revision-fenced motion with partial truth and idempotent replay", async () => {
    const current = await fixture("campaign-motion");
    const missingClipId = randomUUID();
    const preflightScope = {
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      workspaceOwnerUserId: current.user.id,
      projectId: current.project.id,
      pricingTier: "business",
      role: "owner" as const,
      status: "active" as const,
      isPersonalWorkspace: false,
    };
    const preflight = await campaignOperationService.previewEditorAction(
      preflightScope,
      {
        action: "apply_motion",
        input: {
          change: {
            scope: "clip_transition",
            transition: { type: "none", durationSec: 0.4 },
          },
          clips: [{ clipId: current.clip.id, expectedEditorRevision: 2 }],
        },
      },
    );
    expect(preflight).toMatchObject({
      counts: { stale: 1, eligible: 0 },
      items: [{ clipId: current.clip.id, status: "stale" }],
    });
    const scope = {
      actorUserId: current.user.id,
      workspaceId: current.workspace.id,
      projectId: current.project.id,
      pricingTier: "business" as const,
      role: "owner" as const,
      status: "active" as const,
      idempotencyKey: randomUUID(),
    };
    const request = {
      change: {
        scope: "clip_transition" as const,
        transition: { type: "fade-black" as const, durationSec: 0.55 },
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
      counts: {
        succeeded: 1,
        unchanged: 0,
        stale: 0,
        ineligible: 1,
        failed: 0,
      },
    });
    expect(replay).toMatchObject({ operationId: first.operationId, replayed: true });

    const persisted = await clipEditorDocumentPersistence.readDocument({
      actorUserId: current.user.id,
      projectId: current.project.id,
      clipId: current.clip.id,
    });
    expect(persisted).toMatchObject({
      revision: 4,
      document: {
        studioEdits: {
          transition: { type: "fade-black", durationSec: 0.55 },
        },
      },
    });
    const operation = await prisma.campaignOperation.findUniqueOrThrow({
      where: { id: first.operationId },
      include: { items: true },
    });
    expect(operation.items.map((item) => [item.requestedClipId, item.status, item.errorCode]).sort()).toEqual([
      [current.clip.id, "succeeded", null],
      [missingClipId, "ineligible", "campaign_clip_not_found"],
    ].sort());

    const stale = await campaignOperationService.applyMotionSelected(
      { ...scope, idempotencyKey: randomUUID() },
      {
        change: {
          scope: "clip_transition",
          transition: { type: "dip-white", durationSec: 0.4 },
        },
        clips: [{ clipId: current.clip.id, expectedEditorRevision: 3 }],
      },
    );
    expect(stale.counts).toMatchObject({ stale: 1, succeeded: 0 });

    const source = await prisma.campaignOperation.findUniqueOrThrow({
      where: { id: stale.operationId },
    });
    const retry = await campaignOperationService.applyMotionSelected(
      {
        ...scope,
        idempotencyKey: randomUUID(),
        retryOfId: source.id,
      },
      {
        change: {
          scope: "clip_transition",
          transition: { type: "dip-white", durationSec: 0.4 },
        },
        clips: [{ clipId: current.clip.id, expectedEditorRevision: 4 }],
      },
    );
    expect(
      await prisma.campaignOperation.findUniqueOrThrow({
        where: { id: retry.operationId },
        select: { retryOfId: true },
      }),
    ).toEqual({ retryOfId: source.id });
    await expect(
      campaignOperationService.applyMotionSelected(
        {
          ...scope,
          idempotencyKey: (
            await prisma.campaignOperation.findUniqueOrThrow({
              where: { id: retry.operationId },
              select: { idempotencyKey: true },
            })
          ).idempotencyKey,
          retryOfId: source.id,
        },
        {
          change: {
            scope: "clip_transition",
            transition: { type: "dip-white", durationSec: 0.4 },
          },
          clips: [{ clipId: current.clip.id, expectedEditorRevision: 4 }],
        },
      ),
    ).resolves.toMatchObject({ operationId: retry.operationId, replayed: true });
    await expect(
      campaignOperationService.applyMotionSelected(
        {
          ...scope,
          idempotencyKey: (
            await prisma.campaignOperation.findUniqueOrThrow({
              where: { id: retry.operationId },
              select: { idempotencyKey: true },
            })
          ).idempotencyKey,
        },
        {
          change: {
            scope: "clip_transition",
            transition: { type: "dip-white", durationSec: 0.4 },
          },
          clips: [{ clipId: current.clip.id, expectedEditorRevision: 4 }],
        },
      ),
    ).rejects.toMatchObject({ code: "campaign_operation_idempotency_conflict" });
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
      items: { create: { requestedClipId: current.clip.id, clipId: current.clip.id, expectedEditorRevision: 3, status: "failed", errorCode: "campaign_render_admission_failed" } },
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
    await expect(reviewService.authenticate(created.token, { identity: "Client", email: "client@example.test", passcode: "wrong-passcode" }, "203.0.113.10", sessionSecret)).rejects.toMatchObject({ code: "review_access_invalid" });
    const firstSession = await reviewService.authenticate(created.token, { identity: "Client", email: "client@example.test", passcode: "review-secret" }, "203.0.113.10", sessionSecret);
    const secondSession = await reviewService.authenticate(created.token, { identity: "Client updated", email: "CLIENT@example.test", passcode: "review-secret" }, "203.0.113.10", sessionSecret);
		const additionalSessions = [];
		for (let index = 0; index < 10; index += 1) {
			additionalSessions.push(await reviewService.authenticate(created.token, { identity: `Reviewer ${index + 1}`, email: `reviewer-${index + 1}@example.test`, passcode: "review-secret" }, "203.0.113.10", sessionSecret));
		}
		expect(additionalSessions).toHaveLength(10);
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
    const createdExport = await clipExportService.create(
      current.project.id,
      current.clip.id,
      { expectedRevision: finalDocument.revision, aspectRatios: ["9:16"], resolution: "1080p" },
      randomUUID(),
      { workspaceId: current.workspace.id, actorUserId: current.user.id },
    );
    const render = await prisma.clipRender.findFirstOrThrow({
      where: { exportVariant: { exportId: createdExport.export.id } },
      select: { clipSnapshot: true },
    });
    expect(Reflect.get(render.clipSnapshot as object, "editorDocumentVersion")).toBe(2);
    expect(Reflect.get(render.clipSnapshot as object, "sceneBlocks")).toHaveLength(2);
  });
});
