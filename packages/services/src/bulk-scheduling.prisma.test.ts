import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import {
  createPrismaBulkSchedulingStore,
  createProductionBulkPublicationScheduler,
} from "./bulk-scheduling.prisma";
import { publicationIntentHash } from "./social-publication-scheduling";
import {
  createInMemoryReviewApprovalStore,
  createReviewApprovalService,
} from "./review-approval.service";

describe("production bulk-publication adapter", () => {
	test("projects credential refreshability without returning stored token material", async () => {
		const queries: unknown[] = [];
		const fake = {
			socialAccount: {
				findFirst: async (input: { select: unknown }) => {
					queries.push(input.select);
					return {
						id: "account-1",
						workspaceId: "workspace-1",
						platform: "youtube_shorts",
						status: "active",
						expiresAt: new Date("2026-08-31T09:00:00.000Z"),
						refreshTokenEncrypted: "encrypted-refresh-token",
					};
				},
			},
		} as unknown as PrismaClient;

		const account = await createPrismaBulkSchedulingStore(fake).readAccount({
			actorUserId: "actor-1",
			ownerUserId: "owner-1",
			workspaceId: "workspace-1",
			projectId: "project-1",
			approvalPrincipal: { kind: "browser", actorUserId: "actor-1" },
			accountId: "account-1",
		});

		expect(account).toEqual({
			id: "account-1",
			workspaceId: "workspace-1",
			platform: "youtube_shorts",
			status: "active",
			expiresAt: new Date("2026-08-31T09:00:00.000Z"),
			refreshable: true,
		});
		expect(account).not.toHaveProperty("refreshTokenEncrypted");
		expect(queries).toEqual([
			expect.objectContaining({ refreshTokenEncrypted: true }),
		]);
	});

  test("reads a personal Business thumbnail from stable user ownership", async () => {
    const queries: unknown[] = [];
    const fake = {
      workspace: {
        findUnique: async () => ({
          personalOwnerUserId: "owner-1",
          pricingTier: "business",
        }),
      },
      visualAsset: {
        findFirst: async (input: { where: unknown }) => {
          queries.push(input.where);
          return {
            id: "asset-1",
            kind: "image",
            contentType: "image/jpeg",
            sizeBytes: 42n,
            fingerprint: "a".repeat(64),
            provenance: "extracted",
            sourceExportVariantId: "variant-1",
            sourceTimeMs: 1_000,
            deletedAt: null,
          };
        },
      },
    } as unknown as PrismaClient;

    await expect(
      createPrismaBulkSchedulingStore(fake).readThumbnail({
        actorUserId: "actor-1",
        ownerUserId: "owner-1",
        workspaceId: "personal-workspace",
        projectId: "project-1",
        approvalPrincipal: { kind: "browser", actorUserId: "actor-1" },
        assetId: "asset-1",
      }),
    ).resolves.toMatchObject({ id: "asset-1" });
    expect(queries).toEqual([
      expect.objectContaining({ id: "asset-1", userId: "owner-1" }),
    ]);
  });

  test("preserves an API-key principal and cannot create an approval override", async () => {
    const approvalStore = createInMemoryReviewApprovalStore({
      projectApprovalRequired: true,
      exports: [{
        exportId: "export-1",
        evidence: [],
      }],
    });
    const approval = createReviewApprovalService({
      store: approvalStore,
      async authorizeOverride() {
        throw new Error("API-key scheduling must not authorize a browser override");
      },
      rolloutPolicy: { modeFor: () => "enforce" },
      createId: () => "override-1",
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    });
    const principals: unknown[] = [];
    const scheduler = createProductionBulkPublicationScheduler({
      findExactVariant: async () => ({ id: "variant-1", durationSec: 30 }),
      publicationScheduling: {
        async schedule(input) {
          principals.push(input.approvalPrincipal);
          await approval.authorizeExactExports({
            principal: input.approvalPrincipal,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            exportIds: ["export-1"],
            idempotencyKey: input.clientIdempotencyKey,
            overrideReason: input.approvalOverrideReason,
          });
          return { id: "post-1", status: "scheduled" };
        },
      },
    });

    await expect(scheduler.schedule({
      itemKey: "item-1",
      actorUserId: "actor-1",
      ownerUserId: "owner-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      clientIdempotencyKey: "request-1",
      clipId: "clip-1",
      expectedEditorRevision: 1,
      exportVariantId: "variant-1",
      accountId: "account-1",
      platform: "youtube_shorts",
      caption: "Approved copy",
      aspectRatio: "9:16",
      resolution: "1080p",
      durationSec: 30,
      scheduledFor: new Date("2026-09-01T00:00:00.000Z"),
      providerSettings: {},
      assistedCopyDraftId: "copy-1",
      assistedCopyRevision: 1,
      approvalOverrideReason: "Bypass client approval",
      approvalPrincipal: { kind: "api_key", apiKeyId: "api-key-1" },
    })).rejects.toMatchObject({ code: "review_override_forbidden" });

    expect(principals).toEqual([{ kind: "api_key", apiKeyId: "api-key-1" }]);
    expect(await approvalStore.countOverrides()).toBe(0);
  });

  test("reconciles a committed Social Post after the scheduling response is lost", async () => {
    const posts = new Map<
      string,
      { id: string; status: "scheduled"; immutableRequestHash: string }
    >();
    let scheduleCalls = 0;
    const scheduler = createProductionBulkPublicationScheduler({
      findExactVariant: async () => ({ id: "variant-1", durationSec: 30 }),
      publicationScheduling: {
        async schedule(input) {
          scheduleCalls += 1;
          const post = {
            id: "post-1",
            status: "scheduled" as const,
            immutableRequestHash: publicationIntentHash(input),
          };
          posts.set(`${input.workspaceId}:${input.clientIdempotencyKey}`, post);
          throw Object.assign(
            new Error("connection closed after transaction commit"),
            { code: "ECONNRESET" },
          );
        },
      },
      findCommittedIntent: async (input) =>
        posts.get(`${input.workspaceId}:${input.clientIdempotencyKey}`) ?? null,
    });

    await expect(scheduler.schedule({
      itemKey: "item-1",
      actorUserId: "actor-1",
      ownerUserId: "owner-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      clientIdempotencyKey: "request-1",
      clipId: "clip-1",
      expectedEditorRevision: 1,
      exportVariantId: "variant-1",
      accountId: "account-1",
      platform: "youtube_shorts",
      caption: "Approved copy",
      aspectRatio: "9:16",
      resolution: "1080p",
      durationSec: 30,
      scheduledFor: new Date("2026-09-01T00:00:00.000Z"),
      providerSettings: {},
      assistedCopyDraftId: "copy-1",
      assistedCopyRevision: 1,
      approvalOverrideReason: null,
      approvalPrincipal: { kind: "browser_user" },
    })).resolves.toEqual({ postId: "post-1", status: "scheduled" });
    expect(scheduleCalls).toBe(1);
    expect(posts.size).toBe(1);
  });

  test("does not reconcile a child idempotency key bound to different immutable inputs", async () => {
    const scheduler = createProductionBulkPublicationScheduler({
      findExactVariant: async () => ({ id: "variant-1", durationSec: 30 }),
      publicationScheduling: {
        async schedule() {
          throw new TypeError("connection closed after transaction commit");
        },
      },
      findCommittedIntent: async () => ({
        id: "post-foreign",
        status: "scheduled",
        immutableRequestHash: "f".repeat(64),
      }),
    });

    await expect(scheduler.schedule({
      itemKey: "item-1",
      actorUserId: "actor-1",
      ownerUserId: "owner-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      clientIdempotencyKey: "request-1",
      clipId: "clip-1",
      expectedEditorRevision: 1,
      exportVariantId: "variant-1",
      accountId: "account-1",
      platform: "youtube_shorts",
      caption: "Approved copy",
      aspectRatio: "9:16",
      resolution: "1080p",
      durationSec: 30,
      scheduledFor: new Date("2026-09-01T00:00:00.000Z"),
      providerSettings: {},
      assistedCopyDraftId: "copy-1",
      assistedCopyRevision: 1,
      approvalOverrideReason: null,
      approvalPrincipal: { kind: "browser_user" },
    })).rejects.toMatchObject({ code: "bulk_schedule_publication_conflict" });
  });

  test("returns a retryable reconciliation hold when an ambiguous error has no readable row yet", async () => {
    const scheduler = createProductionBulkPublicationScheduler({
      findExactVariant: async () => ({ id: "variant-1", durationSec: 30 }),
      publicationScheduling: {
        async schedule() {
          throw new TypeError("connection closed with unknown commit outcome");
        },
      },
      findCommittedIntent: async () => null,
    });

    await expect(scheduler.schedule({
      itemKey: "item-1",
      actorUserId: "actor-1",
      ownerUserId: "owner-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      clientIdempotencyKey: "request-1",
      clipId: "clip-1",
      expectedEditorRevision: 1,
      exportVariantId: "variant-1",
      accountId: "account-1",
      platform: "youtube_shorts",
      caption: "Approved copy",
      aspectRatio: "9:16",
      resolution: "1080p",
      durationSec: 30,
      scheduledFor: new Date("2026-09-01T00:00:00.000Z"),
      providerSettings: {},
      assistedCopyDraftId: "copy-1",
      assistedCopyRevision: 1,
      approvalOverrideReason: null,
      approvalPrincipal: { kind: "browser_user" },
    })).rejects.toMatchObject({
      code: "bulk_schedule_publication_reconciliation_required",
    });
  });
});
