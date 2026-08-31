import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import {
	createInMemoryPublicationSchedulingStore,
	createProductionSocialPublicationScheduling,
} from "./social-publication-scheduling";

const exactInput = {
	actorUserId: "actor-1",
	approvalPrincipal: { kind: "browser" as const, actorUserId: "actor-1" },
	ownerUserId: "owner-1",
	workspaceId: "workspace-1",
	projectId: "project-1",
	clientIdempotencyKey: "schedule-exact-variant-1",
	clipId: "clip-1",
	expectedEditorRevision: 7,
	accountId: "account-1",
	platform: "youtube_shorts" as const,
	caption: "Approved caption",
	aspectRatio: "9:16" as const,
	resolution: "1080p" as const,
	scheduledFor: new Date("2026-09-01T10:00:00.000Z"),
	providerSettings: { privacy: "public" },
	approvalOverrideReason: null,
	requiredExportVariantId: "variant-selected",
};

describe("production Social Publication scheduling", () => {
	test("freezes the selected completed export variant into the Social Post", async () => {
		const exactExportQueries: unknown[] = [];
		let preparationCalls = 0;
		const approvedExportIds: string[][] = [];
		const prisma = {
			project: {
				findFirst: async () => ({ id: "project-1" }),
			},
			clip: {
				findFirst: async () => ({ id: "clip-1", editorRevision: 7 }),
			},
			socialAccount: {
				findFirst: async () => ({ id: "account-1" }),
			},
			clipExport: {
				findFirst: async (query: { where: unknown }) => {
					exactExportQueries.push(query.where);
					return {
						id: "export-selected",
						editorRevision: 7,
						fingerprint: "export-fingerprint",
						variants: [
							{
								id: "variant-selected",
								status: "completed",
								storageKey:
									"projects/project-1/exports/export-selected/variant-selected.mp4",
								sizeBytes: 42_000n,
								durationSec: 30,
								errorCode: null,
							},
						],
					};
				},
			},
		} as unknown as PrismaClient;
		const scheduling = createProductionSocialPublicationScheduling({
			prisma,
			store: createInMemoryPublicationSchedulingStore(),
			authorize: async () => undefined,
			prepareExport: async () => {
				preparationCalls += 1;
				throw new Error("the selected export must be reused");
			},
			authorizeExactExports: async (input) => {
				approvedExportIds.push(input.exportIds);
				return { overrideAuditId: null };
			},
			createId: () => "social-post-selected",
			now: () => new Date("2026-08-31T10:00:00.000Z"),
		});

		const post = await scheduling.schedule(exactInput);

		expect(post).toMatchObject({
			id: "social-post-selected",
			status: "scheduled",
			frozen: {
				clipExportId: "export-selected",
				clipExportVariantId: "variant-selected",
				editorRevision: 7,
				storageKey:
					"projects/project-1/exports/export-selected/variant-selected.mp4",
			},
		});
		expect(preparationCalls).toBe(0);
		expect(approvedExportIds).toEqual([["export-selected"]]);
		expect(exactExportQueries).toEqual([
			expect.objectContaining({
				workspaceId: "workspace-1",
				projectId: "project-1",
				clipId: "clip-1",
				editorRevision: 7,
			}),
		]);
	});

	test("rejects a selected variant that does not match the immutable export", async () => {
		let preparationCalls = 0;
		let approvalCalls = 0;
		const store = createInMemoryPublicationSchedulingStore();
		const prisma = {
			project: {
				findFirst: async () => ({ id: "project-1" }),
			},
			clip: {
				findFirst: async () => ({ id: "clip-1", editorRevision: 7 }),
			},
			socialAccount: {
				findFirst: async () => ({ id: "account-1" }),
			},
			clipExport: {
				findFirst: async () => null,
			},
		} as unknown as PrismaClient;
		const scheduling = createProductionSocialPublicationScheduling({
			prisma,
			store,
			authorize: async () => undefined,
			prepareExport: async () => {
				preparationCalls += 1;
				throw new Error("the selected export must not be replaced");
			},
			authorizeExactExports: async () => {
				approvalCalls += 1;
				return { overrideAuditId: null };
			},
			createId: () => "social-post-mismatch",
			now: () => new Date("2026-08-31T10:00:00.000Z"),
		});

		await expect(scheduling.schedule(exactInput)).rejects.toMatchObject({
			code: "publication_export_variant_mismatch",
		});
		expect(preparationCalls).toBe(0);
		expect(approvalCalls).toBe(0);
		expect(await store.count()).toBe(0);
	});
});
