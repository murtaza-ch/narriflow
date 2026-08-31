import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	GeneratedMediaError,
	GeneratedMediaStudioError,
} from "@narriflow/services";

import {
	createGeneratedMediaStudioRoutes,
	type GeneratedMediaStudioRouteDependencies,
} from "./generated-media-http";

const ids = {
	actor: "00000000-0000-4000-8000-000000000001",
	workspace: "00000000-0000-4000-8000-000000000002",
	project: "00000000-0000-4000-8000-000000000003",
	clip: "00000000-0000-4000-8000-000000000004",
	job: "00000000-0000-4000-8000-000000000005",
	asset: "00000000-0000-4000-8000-000000000006",
};

function setup(overrides: Partial<GeneratedMediaStudioRouteDependencies> = {}) {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	let input: unknown = {};
	const dependencies: GeneratedMediaStudioRouteDependencies = {
		getActor: () => ({
			actorUserId: ids.actor,
			workspaceId: ids.workspace,
			workspaceOwnerUserId: ids.actor,
			role: "owner",
			status: "active",
			pricingTier: "creator",
			isPersonalWorkspace: true,
		}),
		getInput: () => input,
		getService: () => ({
			async list(...args: unknown[]) {
				calls.push({ name: "list", args });
				return {
					jobs: [],
					capabilities: {
						imageAvailable: true,
						videoAvailable: false,
						supportedImageRatios: ["9:16"],
						supportedVideoRatios: [],
						supportedVideoDurations: [],
					},
					activeBrandProfile: null,
				};
			},
			async get(...args: unknown[]) {
				calls.push({ name: "get", args });
				return { id: ids.job, status: "completed", asset: null };
			},
			async submit(...args: unknown[]) {
				calls.push({ name: "submit", args });
				return { id: ids.job, status: "queued", asset: null };
			},
			async cancel(...args: unknown[]) {
				calls.push({ name: "cancel", args });
				return { id: ids.job, status: "cancelled", asset: null };
			},
			async insert(...args: unknown[]) {
				calls.push({ name: "insert", args });
				return { revision: 4, replayed: false };
			},
			async saveToActiveBrand(...args: unknown[]) {
				calls.push({ name: "brand", args });
				return { profileId: crypto.randomUUID(), profileRevision: 2, assetId: crypto.randomUUID() };
			},
			async deleteAsset(...args: unknown[]) {
				calls.push({ name: "delete", args });
				return { assetId: crypto.randomUUID(), deleted: true as const };
			},
			async resolveBrollPlayback(...args: unknown[]) {
				calls.push({ name: "playback", args });
				return {
					assetId: ids.asset,
					fingerprint: "a".repeat(64),
					mediaKind: "image" as const,
					state: "available" as const,
					accessUrl: "https://signed.example.test/private.png",
				};
			},
			async download(...args: unknown[]) {
				calls.push({ name: "download", args });
				return {
					accessUrl: "https://signed.example.test/attachment.png",
				};
			},
		}),
		...overrides,
	};
	const app = new Hono();
	app.route("/", createGeneratedMediaStudioRoutes(dependencies));
	return {
		app,
		calls,
		setInput(value: unknown) {
			input = value;
		},
	};
}

describe("generated-media Studio HTTP routes", () => {
	test("binds B-roll playback to the tenant project, Clip, and exact asset identity", async () => {
		const { app, calls, setInput } = setup();
		setInput({
			id: ids.project,
			clipId: ids.clip,
			assetId: ids.asset,
			fingerprint: "a".repeat(64),
			mediaKind: "image",
		});
		const response = await app.request(
			`/projects/${ids.project}/clips/${ids.clip}/generated-media/assets/${ids.asset}/playback?fingerprint=${"a".repeat(64)}&mediaKind=image`,
		);

		expect(response.status).toBe(200);
		expect(calls[0]).toMatchObject({
			name: "playback",
			args: [
				{ workspaceId: ids.workspace, actorUserId: ids.actor },
				{
					projectId: ids.project,
					clipId: ids.clip,
					assetId: ids.asset,
					fingerprint: "a".repeat(64),
					mediaKind: "image",
				},
			],
		});
	});

	test("passes the tenant actor and normalized history query to the shared service", async () => {
		const { app, calls, setInput } = setup();
		setInput({ id: ids.project, clipId: ids.clip, limit: 20 });
		const response = await app.request(`/projects/${ids.project}/generated-media/jobs`);

		expect(response.status).toBe(200);
		expect(calls[0]).toMatchObject({
			name: "list",
			args: [
				{ workspaceId: ids.workspace, actorUserId: ids.actor },
				{ projectId: ids.project, clipId: ids.clip, limit: 20 },
			],
		});
	});

	test("issues a job-scoped attachment URL through the authenticated project route", async () => {
		const { app, calls, setInput } = setup();
		setInput({ id: ids.project, jobId: ids.job });
		const response = await app.request(
			`/projects/${ids.project}/generated-media/jobs/${ids.job}/download`,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			accessUrl: "https://signed.example.test/attachment.png",
		});
		expect(calls[0]).toMatchObject({
			name: "download",
			args: [
				{ workspaceId: ids.workspace, actorUserId: ids.actor },
				ids.project,
				ids.job,
			],
		});
	});

	test("rejects a submit whose body claims a different project", async () => {
		const { app, calls, setInput } = setup();
		setInput({
			id: ids.project,
			body: {
				idempotencyKey: crypto.randomUUID(),
				projectId: crypto.randomUUID(),
				clipId: ids.clip,
				kind: "image",
				prompt: "private customer prompt",
				includeDerivedContext: false,
				promptOrigin: { kind: "manual", sourceIds: [] },
				aspectRatio: "9:16",
				sourceRevision: null,
				style: "editorial",
				durationSec: null,
				title: null,
			},
		});
		const response = await app.request(`/projects/${ids.project}/generated-media/jobs`, {
			method: "POST",
		});

		expect(response.status).toBe(404);
		expect(calls).toHaveLength(0);
		expect(JSON.stringify(await response.json())).not.toContain("private customer prompt");
	});

	test("binds insertion to both project and job path identities", async () => {
		const { app, calls, setInput } = setup();
		const insertion = {
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
		};
		setInput({ id: ids.project, jobId: ids.job, body: insertion });
		const response = await app.request(
			`/projects/${ids.project}/generated-media/jobs/${ids.job}/insertions`,
			{ method: "POST" },
		);

		expect(response.status).toBe(200);
		expect(calls[0]).toMatchObject({ name: "insert", args: [expect.anything(), insertion] });
	});

	test("never reflects unknown provider failures into the response", async () => {
		const { app, setInput } = setup({
			getService: () => ({
				list: async () => {
					throw new Error("provider payload https://signed.example.test/secret");
				},
			} as never),
		});
		setInput({ id: ids.project, limit: 20 });
		const response = await app.request(`/projects/${ids.project}/generated-media/jobs`);
		const body = JSON.stringify(await response.json());

		expect(response.status).toBe(503);
		expect(body).not.toContain("provider payload");
		expect(body).not.toContain("signed.example");
	});

	test("returns a stable quota response without reflecting the customer prompt", async () => {
		const { app, setInput } = setup({
			getService: () => ({
				submit: async () => {
					throw new GeneratedMediaError("generated_media_usage_exhausted");
				},
			} as never),
		});
		setInput({
			id: ids.project,
			body: {
				idempotencyKey: crypto.randomUUID(),
				projectId: ids.project,
				clipId: null,
				kind: "image",
				prompt: "private customer prompt",
				includeDerivedContext: false,
				promptOrigin: { kind: "manual", sourceIds: [] },
				aspectRatio: "9:16",
				sourceRevision: null,
				style: "editorial",
				durationSec: null,
				title: null,
			},
		});
		const response = await app.request(
			`/projects/${ids.project}/generated-media/jobs`,
			{ method: "POST" },
		);
		const body = JSON.stringify(await response.json());
		expect(response.status).toBe(429);
		expect(body).toContain("generated_media_usage_exhausted");
		expect(body).not.toContain("private customer prompt");
	});

	test("returns the fresh revision when derived prompt context loses its fence", async () => {
		const { app, setInput } = setup({
			getService: () => ({
				submit: async () => {
					throw new GeneratedMediaStudioError(
						"generated_media_prompt_source_revision_conflict",
						9,
					);
				},
			} as never),
		});
		setInput({
			id: ids.project,
			body: {
				idempotencyKey: crypto.randomUUID(),
				projectId: ids.project,
				clipId: ids.clip,
				kind: "image",
				prompt: "A private selected moment",
				includeDerivedContext: true,
				promptOrigin: {
					kind: "transcript_selection",
					sourceIds: [`clip:${ids.clip}:transcript:4:1`],
				},
				sourceRevision: 8,
				aspectRatio: "9:16",
				style: "editorial",
				durationSec: null,
				title: null,
			},
		});

		const response = await app.request(
			`/projects/${ids.project}/generated-media/jobs`,
			{ method: "POST" },
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "generated_media_prompt_source_revision_conflict",
			currentRevision: 9,
		});
	});
});
