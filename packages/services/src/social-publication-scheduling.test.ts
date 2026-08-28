import { describe, expect, test } from "bun:test";
import {
	createInMemoryPublicationSchedulingStore,
	createSocialPublicationScheduling,
	PublicationIntentConflictError,
	type FrozenPublicationState,
} from "./social-publication-scheduling";

const readyState: FrozenPublicationState = {
	clipExportId: "export-1",
	clipExportVariantId: "variant-1",
	editorRevision: 7,
	exportFingerprint: "fingerprint-1",
	storageKey: "projects/project-1/exports/export-1/variant-1.mp4",
	sizeBytes: 42_000,
	aspectRatio: "9:16",
	caption: "Approved caption",
	providerSettings: { privacy: "public" },
	socialAccountId: "account-1",
	platform: "youtube_shorts",
	capabilityVersion: "youtube-2026-08",
	scheduledFor: new Date("2026-08-29T10:00:00.000Z"),
};

const baseInput = {
	actorUserId: "actor-1",
	ownerUserId: "owner-1",
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

describe("Social Publication scheduling", () => {
	test("replays one immutable publication intent", async () => {
		const store = createInMemoryPublicationSchedulingStore();
		let freezes = 0;
		const scheduling = createSocialPublicationScheduling({
			store,
			authorize: async () => undefined,
			freeze: async () => {
				freezes += 1;
				return { kind: "ready", state: readyState };
			},
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
			authorize: async () => undefined,
			freeze: async () => {
				freezes += 1;
				return { kind: "ready", state: readyState };
			},
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
			authorize: async () => undefined,
			freeze: async () => ({ kind: "ready", state: readyState }),
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
			authorize: async () => undefined,
			freeze: async () => ({ kind: "ready", state: readyState }),
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
		const preparingState = {
			...readyState,
			storageKey: null,
			sizeBytes: null,
		};
		const scheduling = createSocialPublicationScheduling({
			store,
			authorize: async () => undefined,
			freeze: async () => ({ kind: "preparing", state: preparingState }),
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
			authorize: async () => undefined,
			freeze: async () => ({
				kind: "preparing",
				state: { ...readyState, storageKey: null, sizeBytes: null },
			}),
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
		});
		expect(await scheduling.get("workspace-1", "social-post-1")).toMatchObject({
			status: "cancelled",
		});
	});
});
