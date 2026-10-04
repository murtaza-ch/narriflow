import { describe, expect, test } from "bun:test";
import {
	createInMemoryPublicationSchedulingStore,
	createSocialPublicationScheduling,
	socialAccountCanPublishAt,
	PublicationIntentConflictError,
	type FrozenPublicationState,
	type PublicationFreezePorts,
	type PublicationExportFacts,
	type PublicationSchedulingActor,
	type SchedulePublicationInput,
	publicationIntentHash,
} from "./social-publication-scheduling";
import { AssistedSocialCopyError } from "./assisted-social-copy";

const readyState: FrozenPublicationState = {
	clipExportId: "export-1",
	clipExportVariantId: "variant-1",
	editorRevision: 7,
	exportFingerprint: "fingerprint-1",
	storageKey: "projects/project-1/exports/export-1/variant-1.mp4",
	sizeBytes: 42_000,
	durationSec: 30,
	aspectRatio: "9:16",
	caption: "Approved caption",
	providerSettings: { privacy: "public" },
	socialAccountId: "account-1",
	platform: "youtube_shorts",
	capabilityVersion: "youtube-2026-08",
	scheduledFor: new Date("2026-08-29T10:00:00.000Z"),
};

test("expired social credentials require a refresh token at scheduling time", () => {
	const now = new Date("2026-08-28T10:00:00.000Z");
	expect(
		socialAccountCanPublishAt(
			{ expiresAt: null, canRefresh: false },
			now,
		),
	).toBe(true);
	expect(
		socialAccountCanPublishAt(
			{
				expiresAt: new Date("2026-08-28T09:59:59.000Z"),
				canRefresh: false,
			},
			now,
		),
	).toBe(false);
	expect(
		socialAccountCanPublishAt(
			{
				expiresAt: new Date("2026-08-28T09:59:59.000Z"),
				canRefresh: true,
			},
			now,
		),
	).toBe(true);
});

const baseInput = {
	actorUserId: "actor-1",
	workspaceId: "workspace-1",
	projectId: "project-1",
	clientIdempotencyKey: "schedule-intent-1",
	clipId: "clip-1",
	expectedEditorRevision: 7,
	accountId: "account-1",
	platform: "youtube_shorts" as const,
	caption: "Approved caption",
	aspectRatio: "9:16" as const,
	resolution: "1080p" as const,
	scheduledFor: new Date("2026-08-29T10:00:00.000Z"),
	providerSettings: { privacy: "public" },
};

const actor: PublicationSchedulingActor = {
	actorUserId: "actor-1", workspaceId: "workspace-1", workspaceOwnerUserId: "owner-1",
	role: "owner", status: "active", pricingTier: "pro", isPersonalWorkspace: true,
};
const readyExport: PublicationExportFacts = {
	id: "export-1", workspaceId: "workspace-1", projectId: "project-1", clipId: "clip-1",
	editorRevision: 7, resolution: "1080p", fingerprint: "fingerprint-1",
	variants: [{ id: "variant-1", aspectRatio: "9:16", resolution: "1080p", status: "completed", storageKey: readyState.storageKey, sizeBytes: readyState.sizeBytes, durationSec: readyState.durationSec }],
};
const preparingExport: PublicationExportFacts = { ...readyExport, variants: readyExport.variants.map((variant) => ({ ...variant, status: "queued", storageKey: null, sizeBytes: null, durationSec: null })) };
function makePorts(overrides: Partial<PublicationFreezePorts> = {}): PublicationFreezePorts {
	return {
		providerEnabled: () => true,
		capabilityVersion: () => "youtube-2026-08",
		projectExists: async () => true,
		readClip: async () => ({ editorRevision: 7 }),
		readAccount: async () => ({ workspaceId: "workspace-1", platform: "youtube_shorts", status: "active", expiresAt: null, canRefresh: false }),
		readExport: async () => readyExport,
		createExport: async () => "export-1",
		tiktokOptions: async () => ({ inboxEnabled: true, directEnabled: true, privacyOptions: ["PUBLIC"], commentDisabled: false, duetDisabled: false, stitchDisabled: false, maximumDurationSec: 60 }),
		requireCopyProvenance: async () => {},
		readThumbnailAsset: async ({ selection }) => ({ id: selection.assetId, contentType: "image/png", sizeBytes: 1024n }),
		thumbnailFrameMatches: async () => true,
		...overrides,
	};
}

const authorizeReview = async ({ exportIds }: { exportIds: string[] }) => ({
	allowed: true as const,
	items: exportIds.map((exportId) => ({
		exportId,
		eligibility: "approved" as const,
		overrideAuditId: null,
	})),
});

describe("Social Publication scheduling", () => {
  test("attributes the intent to its admitting actor and preserves that creator on another actor's replay", async () => {
    const store = createInMemoryPublicationSchedulingStore();
    let freezes = 0;
    let ownerUserId = "owner-before";
    const service = createSocialPublicationScheduling({
      store,
      authorize: async ({ actorUserId, workspaceId }) => ({ ...actor, actorUserId, workspaceId, workspaceOwnerUserId: ownerUserId, role: "editor" }),
      authorizeReview,
      freezePorts: makePorts({ readExport: async () => { freezes += 1; return readyExport; } }),
      createId: () => "post-actor",
      now: () => new Date("2026-08-28T10:00:00.000Z"),
    });
    const first = await service.schedule(baseInput);
    expect(first.createdByUserId).toBe(baseInput.actorUserId);
    ownerUserId = "owner-after";
    const replay = await service.schedule({ ...baseInput, actorUserId: "another-editor" });
    expect(replay).toEqual(first);
    expect(replay.createdByUserId).toBe(baseInput.actorUserId);
    expect(freezes).toBe(1);
  });

	test("replays one immutable publication intent", async () => {
		const store = createInMemoryPublicationSchedulingStore();
		let freezes = 0;
		const scheduling = createSocialPublicationScheduling({
			store,
			authorize: async () => actor,
			authorizeReview,
			freezePorts: makePorts({ readExport: async () => { freezes += 1; return readyExport; } }),
			createId: () => "social-post-1",
			now: () => new Date("2026-08-28T10:00:00.000Z"),
		});

		const [first, replay] = await Promise.all([
			scheduling.schedule(baseInput),
			scheduling.schedule(baseInput),
		]);

		expect(first).toEqual(replay);
		expect(first).toMatchObject({
			id: "social-post-1",
			status: "scheduled",
			frozen: {
				clipExportVariantId: "variant-1",
				editorRevision: 7,
				storageKey: "projects/project-1/exports/export-1/variant-1.mp4",
			},
		});
		expect(await store.count()).toBe(1);
		expect(freezes).toBe(1);
	});

	test("replays the original intent after its scheduled time without freezing again", async () => {
		const store = createInMemoryPublicationSchedulingStore();
		let now = new Date("2026-08-28T10:00:00.000Z");
		let freezes = 0;
		const scheduling = createSocialPublicationScheduling({
			store,
			authorize: async () => actor,
			authorizeReview,
			freezePorts: makePorts({ readExport: async () => { freezes += 1; return readyExport; } }),
			createId: () => "social-post-1",
			now: () => now,
		});

		const original = await scheduling.schedule(baseInput);
		now = new Date("2026-08-30T10:00:00.000Z");
		await expect(scheduling.schedule(baseInput)).resolves.toEqual(original);
		expect(freezes).toBe(1);
	});

	test("rejects a new publication intent whose schedule is not in the future", async () => {
		const scheduling = createSocialPublicationScheduling({
			store: createInMemoryPublicationSchedulingStore(),
			authorize: async () => actor,
			authorizeReview,
			freezePorts: makePorts(),
			createId: () => "social-post-1",
			now: () => new Date("2026-08-30T10:00:00.000Z"),
		});

		await expect(scheduling.schedule(baseInput)).rejects.toMatchObject({
			code: "publication_schedule_in_past",
		});
	});

	test("rejects one key reused with materially different immutable input", async () => {
		const store = createInMemoryPublicationSchedulingStore();
		const scheduling = createSocialPublicationScheduling({
			store,
			authorize: async () => actor,
			authorizeReview,
			freezePorts: makePorts(),
			createId: () => "social-post-1",
			now: () => new Date("2026-08-28T10:00:00.000Z"),
		});
		await scheduling.schedule(baseInput);

		await expect(
			scheduling.schedule({ ...baseInput, caption: "Changed caption" }),
		).rejects.toBeInstanceOf(PublicationIntentConflictError);
		expect(await store.count()).toBe(1);
	});

	test("projects Preparing video and advances the same post when its exact export completes", async () => {
		const store = createInMemoryPublicationSchedulingStore();
		const scheduling = createSocialPublicationScheduling({
			store,
			authorize: async () => actor,
			authorizeReview,
			freezePorts: makePorts({ readExport: async () => preparingExport }),
			createId: () => "social-post-1",
			now: () => new Date("2026-08-28T10:00:00.000Z"),
		});

		const preparing = await scheduling.schedule(baseInput);
		expect(preparing.status).toBe("preparing_video");
		expect(preparing.submissionEligible).toBe(false);

		await scheduling.recordExportReady({
			clipExportVariantId: "variant-1",
			storageKey: readyState.storageKey!,
			sizeBytes: readyState.sizeBytes!,
			durationSec: readyState.durationSec!,
		});

		const scheduled = await scheduling.get("workspace-1", "social-post-1");
		expect(scheduled).toMatchObject({
			id: "social-post-1",
			status: "scheduled",
			submissionEligible: true,
			frozen: {
				clipExportVariantId: "variant-1",
				storageKey: readyState.storageKey,
			},
		});
	});

	test("cancellation wins before readiness and cannot be revived", async () => {
		const store = createInMemoryPublicationSchedulingStore();
		const scheduling = createSocialPublicationScheduling({
			store,
			authorize: async () => actor,
			authorizeReview,
			freezePorts: makePorts({ readExport: async () => preparingExport }),
			createId: () => "social-post-1",
			now: () => new Date("2026-08-28T10:00:00.000Z"),
		});
		await scheduling.schedule(baseInput);

		expect(
			await scheduling.cancel({
				actorUserId: "actor-1",
				workspaceId: "workspace-1",
				postId: "social-post-1",
			}),
		).toMatchObject({ status: "cancelled" });
		await scheduling.recordExportReady({
			clipExportVariantId: "variant-1",
			storageKey: readyState.storageKey!,
			sizeBytes: readyState.sizeBytes!,
			durationSec: readyState.durationSec!,
		});
		expect(await scheduling.get("workspace-1", "social-post-1")).toMatchObject({
			status: "cancelled",
		});
	});

	test("checks the exact frozen export and keeps its override audit reference", async () => {
		const checks: Array<Record<string, unknown>> = [];
		const scheduling = createSocialPublicationScheduling({
			store: createInMemoryPublicationSchedulingStore(),
			authorize: async () => actor,
			authorizeReview: async (input) => {
				checks.push(input);
				return {
					allowed: true,
					items: [
						{
							exportId: "export-1",
							eligibility: "overridden",
							overrideAuditId: "audit-1",
						},
					],
				};
			},
			freezePorts: makePorts(),
			createId: () => "social-post-1",
			now: () => new Date("2026-08-28T10:00:00.000Z"),
		});

		const post = await scheduling.schedule({
			...baseInput,
			reviewOverrideReason: "Legal approved an urgent release.",
		});

		expect(checks).toEqual([
			{
				principal: { kind: "workspace_user", userId: "actor-1" },
				workspaceId: "workspace-1",
				projectId: "project-1",
				exportIds: ["export-1"],
				idempotencyKey: "schedule-intent-1",
				overrideReason: "Legal approved an urgent release.",
			},
		]);
		expect(post.reviewApprovalOverrideId).toBe("audit-1");
	});
});

test("immediate admission survives elapsed queue time while scheduled admission rejects the past", async () => {
	const scheduling = createSocialPublicationScheduling({
		store: createInMemoryPublicationSchedulingStore(),
		authorize: async () => actor,
		authorizeReview,
		freezePorts: makePorts(),
		createId: () => "now-post",
		now: () => new Date("2026-08-29T10:01:00.000Z"),
	});
	await expect(scheduling.schedule(baseInput)).rejects.toMatchObject({
		code: "publication_schedule_in_past",
	});
	const immediate = { ...baseInput, immediate: true };
	const admitted = await scheduling.schedule(immediate);
	expect(admitted.frozen.scheduledFor).toEqual(baseInput.scheduledFor);
	expect(await scheduling.schedule(immediate)).toEqual(admitted);
});

function policyHarness(ports: Partial<PublicationFreezePorts> = {}) {
	let authorizations = 0;
	const store = createInMemoryPublicationSchedulingStore();
	const module = createSocialPublicationScheduling({
		store,
		authorize: async () => { authorizations += 1; return actor; },
		authorizeReview,
		freezePorts: makePorts(ports),
		createId: () => "social-post-1",
		now: () => new Date("2026-08-28T10:00:00.000Z"),
	});
	return { module, store, authorizations: () => authorizations };
}

describe("publication freeze policy through admission", () => {
	test("replays before all mutable facts disappear while checking current authority", async () => {
		let unavailable = false;
		const mutableRead = () => { if (unavailable) throw new Error("mutable facts unavailable"); };
		const h = policyHarness({
			providerEnabled: () => { mutableRead(); return true; },
			projectExists: async () => { mutableRead(); return true; },
			readClip: async () => { mutableRead(); return { editorRevision: 7 }; },
			readAccount: async () => { mutableRead(); return { workspaceId: actor.workspaceId, platform: "youtube_shorts", status: "active", expiresAt: null, canRefresh: false }; },
			readExport: async () => { mutableRead(); return readyExport; },
			requireCopyProvenance: async () => { mutableRead(); },
			readThumbnailAsset: async () => { mutableRead(); return { id: "cover", contentType: "image/png", sizeBytes: 1024n }; },
		});
		const input = { ...baseInput, assistedCopyVariantId: "copy", thumbnail: { assetId: "cover", fingerprint: "a".repeat(64), source: "uploaded" as const, sourceTimeMs: null } };
		const admitted = await h.module.schedule(input);
		unavailable = true;
		expect(await h.module.schedule(input)).toEqual(admitted);
		expect(h.authorizations()).toBe(2);
		expect(await h.store.count()).toBe(1);
	});

	test.each([
		{ field: "delivery mode", patch: { deliveryMode: "tiktok_inbox" as const } },
		{ field: "copy provenance", patch: { assistedCopyVariantId: "different-copy" } },
		{ field: "thumbnail", patch: { thumbnail: { assetId: "cover", fingerprint: "a".repeat(64), source: "uploaded" as const, sourceTimeMs: null } } },
	])("conflicts on changed $field before reading mutable policy", async ({ patch }) => {
		let reads = 0;
		const h = policyHarness({ projectExists: async () => { reads += 1; return true; } });
		await h.module.schedule(baseInput);
		await expect(h.module.schedule({ ...baseInput, ...patch })).rejects.toBeInstanceOf(PublicationIntentConflictError);
		expect(reads).toBe(1);
	});

	test("uses an already authorized actor once and rejects mismatched or incapable actors", async () => {
		const h = policyHarness();
		await h.module.schedule(baseInput, { actor });
		expect(h.authorizations()).toBe(0);
		for (const denied of [{ ...actor, actorUserId: "another-actor" }, { ...actor, workspaceId: "another-workspace" }, { ...actor, role: "viewer" as const }]) {
			await expect(h.module.schedule(baseInput, { actor: denied })).rejects.toMatchObject({ code: "workspace_access_denied", kind: "forbidden" });
		}
	});

	test.each([
		{ code: "social_provider_publishing_disabled", ports: { providerEnabled: () => false } },
		{ code: "project_not_found", ports: { projectExists: async () => false } },
		{ code: "clip_not_found", ports: { readClip: async () => null } },
		{ code: "editor_revision_conflict", ports: { readClip: async () => ({ editorRevision: 8 }) } },
		{ code: "social_account_unavailable", ports: { readAccount: async () => null } },
		{ code: "social_account_unavailable", ports: { readAccount: async () => ({ workspaceId: "other", platform: "youtube_shorts" as const, status: "active", expiresAt: null, canRefresh: false }) } },
		{ code: "social_account_expired", ports: { readAccount: async () => ({ workspaceId: actor.workspaceId, platform: "youtube_shorts" as const, status: "active", expiresAt: new Date("2026-08-28T09:00:00Z"), canRefresh: false }) } },
		{ code: "publication_export_mismatch", ports: { readExport: async () => ({ ...readyExport, editorRevision: 6 }) } },
		{ code: "publication_export_variant_missing", ports: { readExport: async () => ({ ...readyExport, variants: [] }) } },
		{ code: "publication_media_preparation_failed", ports: { readExport: async () => ({ ...readyExport, variants: readyExport.variants.map((variant) => ({ ...variant, status: "failed" })) }) } },
	])("rejects $code without committing a Social Post", async ({ code, ports }) => {
		const h = policyHarness(ports);
		await expect(h.module.schedule(baseInput)).rejects.toMatchObject({ code });
		expect(await h.store.count()).toBe(0);
	});

	test("creates a missing exact export explicitly and never recreates it on replay", async () => {
		const creates: SchedulePublicationInput[] = [];
		const h = policyHarness({ createExport: async (input) => { creates.push(input); return readyExport.id; } });
		const post = await h.module.schedule(baseInput);
		await h.module.schedule(baseInput);
		expect(creates).toEqual([baseInput]);
		expect(post.frozen.providerSettings).toMatchObject({ confirmedBy: baseInput.actorUserId, deliveryMode: "direct" });
	});

	test("requires selected exports to be completed instead of silently preparing another version", async () => {
		const h = policyHarness({ readExport: async () => preparingExport, createExport: async () => { throw new Error("must not create a selected export"); } });
		await expect(h.module.schedule({ ...baseInput, clipExportId: readyExport.id, clipExportVariantId: "variant-1" })).rejects.toMatchObject({ code: "publication_media_preparation_failed" });
	});

	test("keeps immutable copy provenance and validates extracted covers against the frozen variant", async () => {
		const provenance: unknown[] = [];
		const frames: unknown[] = [];
		const h = policyHarness({ requireCopyProvenance: async (input) => { provenance.push(input); }, thumbnailFrameMatches: async (input) => { frames.push(input); return true; } });
		const post = await h.module.schedule({ ...baseInput, assistedCopyVariantId: "copy", thumbnail: { assetId: "cover", fingerprint: "a".repeat(64), source: "extracted_frame", sourceTimeMs: 1200 } });
		expect(provenance).toEqual([{ workspaceId: "workspace-1", projectId: "project-1", clipId: "clip-1", platform: "youtube_shorts", variantId: "copy" }]);
		expect(frames).toEqual([{ workspaceId: "workspace-1", projectId: "project-1", clipId: "clip-1", assetId: "cover", sourceTimeMs: 1200, exportVariantId: "variant-1", aspectRatio: "9:16", editorRevision: 7 }]);
		expect(post.frozen.providerSettings).toMatchObject({ assistedCopyVariantId: "copy", thumbnailAssetId: "cover", thumbnailSource: "extracted_frame" });
	});

	test.each([
		{ code: "thumbnail_asset_unavailable", ports: { readThumbnailAsset: async () => null } },
		{ code: "thumbnail_provider_constraint", ports: { readThumbnailAsset: async () => ({ id: "cover", contentType: "image/webp", sizeBytes: 1024n }) } },
		{ code: "thumbnail_provider_constraint", ports: { readThumbnailAsset: async () => ({ id: "cover", contentType: "image/png", sizeBytes: 2_000_001n }) } },
		{ code: "thumbnail_export_mismatch", ports: { thumbnailFrameMatches: async () => false } },
	])("rejects $code for a selected cover without committing", async ({ code, ports }) => {
		const h = policyHarness(ports);
		await expect(h.module.schedule({ ...baseInput, thumbnail: { assetId: "cover", fingerprint: "a".repeat(64), source: "extracted_frame", sourceTimeMs: 1000 } })).rejects.toMatchObject({ code });
		expect(await h.store.count()).toBe(0);
	});

	test("rejects mismatched assisted copy provenance inside admission", async () => {
		const h = policyHarness({ requireCopyProvenance: async () => { throw new AssistedSocialCopyError("assisted_copy_variant_not_found"); } });
		await expect(h.module.schedule({ ...baseInput, assistedCopyVariantId: "missing-copy" })).rejects.toMatchObject({ code: "assisted_copy_variant_not_found" });
		expect(await h.store.count()).toBe(0);
	});

	test.each([
		{ code: "social_account_scope_missing", options: { directEnabled: false } },
		{ code: "tiktok_creator_settings_changed", options: { privacyOptions: [] } },
		{ code: "tiktok_creator_settings_changed", options: { commentDisabled: true } },
		{ code: "tiktok_video_too_long", options: { maximumDurationSec: 20 } },
	])("applies current TikTok creator policy for $code", async ({ code, options }) => {
		const h = policyHarness({ readAccount: async () => ({ workspaceId: actor.workspaceId, platform: "tiktok", status: "active", expiresAt: null, canRefresh: false }), tiktokOptions: async () => ({ inboxEnabled: true, directEnabled: true, privacyOptions: ["PUBLIC"], commentDisabled: false, duetDisabled: false, stitchDisabled: false, maximumDurationSec: 60, ...options }) });
		await expect(h.module.schedule({ ...baseInput, platform: "tiktok", providerSettings: { tiktokPrivacyLevel: "PUBLIC" } })).rejects.toMatchObject({ code });
	});

	test("inbox delivery uses upload scope without direct privacy requirements", async () => {
		const h = policyHarness({ readAccount: async () => ({ workspaceId: actor.workspaceId, platform: "tiktok", status: "active", expiresAt: null, canRefresh: false }), tiktokOptions: async () => ({ inboxEnabled: true, directEnabled: false, privacyOptions: [], commentDisabled: true, duetDisabled: true, stitchDisabled: true, maximumDurationSec: 60 }) });
		const post = await h.module.schedule({ ...baseInput, platform: "tiktok", deliveryMode: "tiktok_inbox" });
		expect(post.frozen).toMatchObject({ deliveryMode: "tiktok_inbox", providerSettings: { deliveryMode: "tiktok_inbox" } });
	});

	test("hashes raw selections and canonical settings without enrichment reads", () => {
		expect(publicationIntentHash({ ...baseInput, providerSettings: { a: 1, b: 2 } })).toBe(publicationIntentHash({ ...baseInput, providerSettings: { b: 2, a: 1 } }));
		expect(publicationIntentHash(baseInput)).not.toBe(publicationIntentHash({ ...baseInput, assistedCopyVariantId: "copy" }));
	});
});
