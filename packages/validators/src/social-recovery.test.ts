import { describe, expect, test } from "bun:test";
import {
	confirmSocialPublicationSchema,
	republishSocialPublicationSchema,
	recheckSocialPublicationSchema,
} from "./social";

describe("social publication recovery validation", () => {
	test("requires evidence matching the selected confirmation kind", () => {
		expect(
			confirmSocialPublicationSchema.safeParse({
				reason: "Verified on the provider",
				evidenceKind: "platform_url",
			}).success,
		).toBe(false);
		expect(
			confirmSocialPublicationSchema.safeParse({
				reason: "Verified on the provider",
				evidenceKind: "provider_reference",
			}).success,
		).toBe(false);
		expect(
			confirmSocialPublicationSchema.safeParse({
				reason: "Verified manually",
				evidenceKind: "manual_unvalidated",
			}).success,
		).toBe(true);
	});

	test("rejects unknown fields on every recovery mutation", () => {
		expect(
			recheckSocialPublicationSchema.safeParse({ reason: "Recheck", checkpoint: "secret" })
				.success,
		).toBe(false);
		expect(
			confirmSocialPublicationSchema.safeParse({
				reason: "Verified",
				evidenceKind: "manual_unvalidated",
				providerState: { raw: true },
			}).success,
		).toBe(false);
		expect(
			republishSocialPublicationSchema.safeParse({
				reason: "Republish",
				duplicateRiskAcknowledged: true,
				force: true,
			}).success,
		).toBe(false);
	});

	test("requires explicit duplicate-risk acknowledgement", () => {
		expect(
			republishSocialPublicationSchema.safeParse({
				reason: "Republish",
				duplicateRiskAcknowledged: false,
			}).success,
		).toBe(false);
	});
});
