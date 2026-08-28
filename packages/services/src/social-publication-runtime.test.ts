import { describe, expect, test } from "bun:test";
import { createVerifiedPublicationWebhookMedia } from "./social-publication-runtime";

const request = {
	storageKey: "private/frozen-export.mp4",
	fileName: "frozen-export.mp4",
	sizeBytes: 1_024,
	expiresInSeconds: 1,
};

describe("production publication webhook media", () => {
	test("preflights exact object existence and byte length before presigning", async () => {
		const calls: string[] = [];
		const media = createVerifiedPublicationWebhookMedia({
			head: async (key) => {
				calls.push(`head:${key}`);
				return {
					contentType: "video/mp4",
					sizeBytes: 1_024,
					etag: "etag",
					metadata: {},
				};
			},
			presign: async ({ key }) => {
				calls.push(`presign:${key}`);
				return "https://media.example/frozen-export.mp4?scoped=true";
			},
			deadlineMs: 10_000,
			clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
		});

		await expect(media.createScopedAccess(request)).resolves.toEqual({
			url: "https://media.example/frozen-export.mp4?scoped=true",
			expiresAt: new Date("2026-08-28T10:15:10.000Z"),
		});
		expect(calls).toEqual([
			"head:private/frozen-export.mp4",
			"presign:private/frozen-export.mp4",
		]);
	});

	test.each([
		["missing", Object.assign(new Error("missing"), { name: "NoSuchKey" })],
		["size mismatch", null],
	])("refuses %s frozen media without issuing a URL", async (_label, headError) => {
		let presigned = false;
		const media = createVerifiedPublicationWebhookMedia({
			head: async () => {
				if (headError) throw headError;
				return {
					contentType: "video/mp4",
					sizeBytes: 999,
					etag: "etag",
					metadata: {},
				};
			},
			presign: async () => {
				presigned = true;
				return "https://media.example/should-not-exist";
			},
			deadlineMs: 10_000,
			clock: { now: () => new Date() },
		});

		await expect(media.createScopedAccess(request)).rejects.toMatchObject({
			code: "publication_frozen_media_missing",
			phase: "preparation",
		});
		expect(presigned).toBe(false);
	});

	test("does not flatten unexpected storage failures", async () => {
		const media = createVerifiedPublicationWebhookMedia({
			head: async () => {
				throw new Error("storage credentials unavailable");
			},
			presign: async () => "unreachable",
			deadlineMs: 10_000,
			clock: { now: () => new Date() },
		});

		await expect(media.createScopedAccess(request)).rejects.toThrow(
			"storage credentials unavailable",
		);
	});
});
