import { describe, expect, test } from "bun:test";
import type { GeneratedMediaSubmitInput } from "@narriflow/validators";

import type { GeneratedMediaJobView, GeneratedMediaStore } from "./generated-media";
import {
	GeneratedMediaStudioError,
	GeneratedMediaStudioService,
	type GeneratedMediaStudioLibrary,
} from "./generated-media-studio";

const ids = {
	actor: "00000000-0000-4000-8000-000000000001",
	workspace: "00000000-0000-4000-8000-000000000002",
	project: "00000000-0000-4000-8000-000000000003",
	clip: "00000000-0000-4000-8000-000000000004",
	job: "00000000-0000-4000-8000-000000000005",
	asset: "00000000-0000-4000-8000-000000000006",
	profile: "00000000-0000-4000-8000-000000000007",
};

const scope = {
	actorUserId: ids.actor,
	workspaceId: ids.workspace,
	workspaceOwnerUserId: ids.actor,
	role: "owner" as const,
	status: "active" as const,
	pricingTier: "creator",
	isPersonalWorkspace: true,
};

function job(overrides: Partial<GeneratedMediaJobView> = {}): GeneratedMediaJobView {
	return {
		id: ids.job,
		workspaceId: ids.workspace,
		projectId: ids.project,
		clipId: ids.clip,
		kind: "image",
		status: "completed",
		provider: "private-provider",
		model: "private-model",
		promptOrigin: {
			kind: "transcript_selection",
			sourceIds: [`clip:${ids.clip}:transcript:private-source`],
		},
		aspectRatio: "9:16",
		style: "editorial",
		durationSec: null,
		resultAssetId: ids.asset,
		insertionCount: 0,
		lastInsertionKind: null,
		lastInsertedAt: null,
		errorCode: null,
		moderation: { outcome: "passed", stage: "output", categories: ["private"] },
		createdAt: "2026-08-31T12:00:00.000Z",
		updatedAt: "2026-08-31T12:01:00.000Z",
		replayed: false,
		...overrides,
	};
}

function setup(options: {
	activeProfile?: { id: string; name: string } | null;
	writeAvailable?: boolean;
	assetProvenance?: "uploaded" | "generated" | "extracted";
} = {}) {
	let current = job();
	const calls = {
		submit: [] as GeneratedMediaSubmitInput[],
		promptContext: [] as unknown[],
		insert: [] as unknown[],
		membership: [] as unknown[],
		delete: [] as unknown[],
		download: [] as unknown[],
	};
	const store = {
		async get(_scope: unknown, jobId: string) {
			return jobId === current.id ? current : null;
		},
		async list() {
			return [current, job({ id: crypto.randomUUID(), clipId: null })];
		},
		async requestCancellation() {
			current = { ...current, status: "cancelled" };
			return current;
		},
	} as unknown as GeneratedMediaStore;
	const library: GeneratedMediaStudioLibrary = {
		async getActiveBrandProfile() {
			return options.activeProfile === undefined
				? { id: ids.profile, name: "Northstar" }
				: options.activeProfile;
		},
		async softDeleteUnreferenced(input) {
			calls.delete.push(input);
			return { assetId: ids.asset, deleted: true as const };
		},
		async resolveFrozenBrollAsset(input) {
			if (
				input.projectId !== ids.project ||
				input.clipId !== ids.clip ||
				input.assetId !== ids.asset
			) {
				return null;
			}
			return {
				assetId: ids.asset,
				fingerprint: input.fingerprint,
				mediaKind: input.mediaKind,
				state: "deleted" as const,
				accessUrl: "https://signed.example.test/retained.png",
			};
		},
		async resolveJobAssets(input) {
			return input.jobs.map((candidate) => ({
				jobId: candidate.jobId,
				state: "available" as const,
				savedToActiveBrandProfile:
					input.activeBrandProfileId === ids.profile && calls.membership.length > 0,
				asset: {
					id: ids.asset,
					title: "Quiet morning",
					kind: "image" as const,
					fingerprint: "a".repeat(64),
					provenance: options.assetProvenance ?? "generated",
					durationSec: null,
					accessUrl: "https://signed.example.test/private.png",
				},
			}));
		},
		async resolveJobDownload(input) {
			calls.download.push(input);
			return input.jobId === ids.job
				? { accessUrl: "https://signed.example.test/attachment.png" }
				: null;
		},
		async resolvePromptContext(input) {
			calls.promptContext.push(input);
			return input.includeDerivedContext
				? "Server-resolved transcript context"
				: null;
		},
	};
	const service = new GeneratedMediaStudioService({
		store,
		library,
		brandProfiles: {
			async get() {
				return { revision: 4, assets: [] };
			},
			async setMembership(_scope, profileId, input) {
				calls.membership.push({ profileId, input });
				return { revision: 5 };
			},
		},
		insertion: {
			async insert(_scope, input) {
				calls.insert.push(input);
				return {
					revision: 4,
					document: { version: 2 },
					kind: "broll" as const,
					targetId: "00000000-0000-4000-8000-000000000008",
					asset: {
						id: ids.asset,
						fingerprint: "a".repeat(64),
						provenance: "generated" as const,
						kind: "image" as const,
					},
					replayed: false,
				} as never;
			},
		},
		submit: async (_scope, input) => {
			calls.submit.push(input);
			return current;
		},
		usageSummary: async () => ({
			image: {
				policy: "metered" as const,
				allowance: {
					period: "calendar_day_utc" as const,
					limitUnits: 20,
					committedUnits: 1,
					availableUnits: 19,
					resetsAt: "2026-09-01T00:00:00.000Z",
				},
				dailyAbuse: {
					limitUnits: 40,
					admittedUnits: 1,
					availableUnits: 39,
					resetsAt: "2026-09-01T00:00:00.000Z",
				},
				settlement: { reservedUnits: 0, finalizedUnits: 1, releasedUnits: 0 },
			},
			video: {
				policy: "metered" as const,
				allowance: {
					period: "calendar_day_utc" as const,
					limitUnits: 60,
					committedUnits: 0,
					availableUnits: 60,
					resetsAt: "2026-09-01T00:00:00.000Z",
				},
				dailyAbuse: {
					limitUnits: 120,
					admittedUnits: 0,
					availableUnits: 120,
					resetsAt: "2026-09-01T00:00:00.000Z",
				},
				settlement: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
			},
		}),
		writeCapabilities: () => ({
			image: options.writeAvailable === false
				? { enabled: false as const, reason: "image_rollout_disabled" }
				: {
						enabled: true as const,
						provider: "openai-image",
						model: "configured-image",
						maxConcurrency: 2,
						usageUnits: 1,
						maxOutputBytes: 16_777_216,
						supportedAspectRatios: ["9:16", "1:1", "16:9"] as const,
					},
			video: { enabled: false as const, reason: "video_provider_adapter_missing" },
		}),
	});
	return { service, calls };
}

describe("GeneratedMediaStudioService", () => {
	test("resolves a deleted frozen B-roll reference after a pricing downgrade", async () => {
		const { service } = setup({ writeAvailable: false });
		await expect(
			service.resolveBrollPlayback(
				{ ...scope, pricingTier: "free" },
				{
					projectId: ids.project,
					clipId: ids.clip,
					assetId: ids.asset,
					fingerprint: "a".repeat(64),
					mediaKind: "image",
				},
			),
		).resolves.toEqual({
			assetId: ids.asset,
			fingerprint: "a".repeat(64),
			mediaKind: "image",
			state: "deleted",
			accessUrl: "https://signed.example.test/retained.png",
		});
	});

	test("does not resolve a frozen reference through another project", async () => {
		const { service } = setup();
		await expect(
			service.resolveBrollPlayback(scope, {
				projectId: crypto.randomUUID(),
				clipId: ids.clip,
				assetId: ids.asset,
				fingerprint: "a".repeat(64),
				mediaKind: "image",
			}),
		).rejects.toMatchObject({ code: "generated_media_studio_not_found" });
	});

	test("keeps history readable with writes disabled and returns only a sanitized projection", async () => {
		const { service } = setup({ writeAvailable: false });
		const result = await service.list(scope, {
			projectId: ids.project,
			clipId: ids.clip,
			limit: 20,
		});

		expect(result.jobs).toHaveLength(1);
		expect(result.jobs[0]).toMatchObject({
			id: ids.job,
			status: "completed",
			moderationOutcome: "passed",
			assetAvailability: "available",
			asset: {
				jobId: ids.job,
				assetId: ids.asset,
				provenance: "generated",
			},
		});
		expect(result.capabilities.imageAvailable).toBe(false);
		expect(result.usage.image.allowance.availableUnits).toBe(19);
		expect(JSON.stringify(result)).not.toContain("private-provider");
		expect(JSON.stringify(result)).not.toContain("private-model");
		expect(JSON.stringify(result)).not.toContain("private-source");
		expect(JSON.stringify(result)).not.toContain("categories");
	});

	test("rejects a status read when the tenant-owned job belongs to another project", async () => {
		const { service } = setup();
		await expect(
			service.get(scope, crypto.randomUUID(), ids.job),
		).rejects.toBeInstanceOf(GeneratedMediaStudioError);
	});

	test("resolves exact prompt context server-side before submission and atomically inserts it", async () => {
		const { service, calls } = setup();
		const request = {
			idempotencyKey: crypto.randomUUID(),
			projectId: ids.project,
			clipId: ids.clip,
			kind: "image" as const,
			prompt: "A calm desk at sunrise",
			includeDerivedContext: true,
			sourceRevision: 6,
			promptOrigin: {
				kind: "transcript_selection" as const,
				sourceIds: [`clip:${ids.clip}:transcript:4:1`],
			},
			aspectRatio: "9:16" as const,
			style: "editorial" as const,
			durationSec: null,
			title: null,
		};
		await service.submit(scope, request);
		await service.insert(scope, {
			idempotencyKey: crypto.randomUUID(),
			jobId: ids.job,
			projectId: ids.project,
			clipId: ids.clip,
			baseRevision: 3,
			action: {
				kind: "insert_broll",
				placementId: crypto.randomUUID(),
				startSec: 2,
				endSec: 5,
			},
		});
		expect(calls.promptContext).toHaveLength(1);
		expect(calls.promptContext[0]).toMatchObject({ sourceRevision: 6 });
		const {
			includeDerivedContext: _includeDerivedContext,
			sourceRevision: _sourceRevision,
			...resolvedRequest
		} = request;
		expect(calls.submit).toEqual([{
			...resolvedRequest,
			derivedContext: "Server-resolved transcript context",
			seed: null,
		}]);
		expect(calls.insert).toHaveLength(1);
	});

	test("saves the exact generated asset into the project's active Brand Profile", async () => {
		const { service, calls } = setup();
		await expect(service.saveToActiveBrand(scope, ids.project, ids.job)).resolves.toEqual({
			profileId: ids.profile,
			profileRevision: 5,
			assetId: ids.asset,
		});
		expect(calls.membership).toEqual([{
			profileId: ids.profile,
			input: { kind: "asset", resourceId: ids.asset, role: "image", position: 0 },
		}]);
		const refreshed = await service.list(scope, {
			projectId: ids.project,
			clipId: ids.clip,
			limit: 20,
		});
		expect(refreshed.jobs[0]?.savedToActiveBrandProfile).toBe(true);
	});

	test("projects and saves an uploaded asset reused as the exact job result", async () => {
		const { service, calls } = setup({ assetProvenance: "uploaded" });

		const listed = await service.list(scope, {
			projectId: ids.project,
			clipId: ids.clip,
			limit: 20,
		});
		expect(listed.jobs[0]?.asset).toMatchObject({
			assetId: ids.asset,
			provenance: "uploaded",
		});
		await expect(
			service.saveToActiveBrand(scope, ids.project, ids.job),
		).resolves.toMatchObject({ assetId: ids.asset, profileId: ids.profile });
		expect(calls.membership).toHaveLength(1);
	});

	test("issues an attachment URL only for the exact tenant project job", async () => {
		const { service, calls } = setup();

		await expect(service.download(scope, ids.project, ids.job)).resolves.toEqual({
			accessUrl: "https://signed.example.test/attachment.png",
		});
		expect(calls.download).toEqual([expect.objectContaining({
			projectId: ids.project,
			jobId: ids.job,
			resultAssetId: ids.asset,
			kind: "image",
		})]);
		await expect(
			service.download(scope, crypto.randomUUID(), ids.job),
		).rejects.toMatchObject({ code: "generated_media_studio_not_found" });
	});

	test("returns a stable absence error instead of pretending workspace ownership is Brand membership", async () => {
		const { service, calls } = setup({ activeProfile: null });
		await expect(
			service.saveToActiveBrand(scope, ids.project, ids.job),
		).rejects.toMatchObject({ code: "generated_media_brand_profile_unavailable" });
		expect(calls.membership).toHaveLength(0);
	});

	test("soft-deletes through the unreferenced-asset store and blocks viewers", async () => {
		const { service, calls } = setup();
		await expect(service.deleteAsset(scope, ids.project, ids.job)).resolves.toEqual({
			assetId: ids.asset,
			deleted: true,
		});
		expect(calls.delete).toHaveLength(1);

		await expect(
			service.deleteAsset(
				{ ...scope, role: "editor", status: "restricted" },
				ids.project,
				ids.job,
			),
		).rejects.toMatchObject({ code: "generated_media_studio_forbidden" });
		await expect(
			service.saveToActiveBrand(
				{ ...scope, role: "editor", status: "restricted" },
				ids.project,
				ids.job,
			),
		).rejects.toMatchObject({ code: "generated_media_studio_forbidden" });
		await expect(
			service.deleteAsset({ ...scope, role: "viewer" }, ids.project, ids.job),
		).rejects.toMatchObject({ code: "generated_media_studio_forbidden" });
	});
});
