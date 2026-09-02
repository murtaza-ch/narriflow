import { describe, expect, test } from "bun:test";
import {
	brandApprovalRequiredByDefault,
  deriveReviewRoundStatus,
  hashReviewAccessToken,
  hashReviewPasscode,
  issueReviewSession,
  verifyReviewPasscode,
  verifyReviewSession,
} from "./review.service";

describe("review guest security primitives", () => {
  const secret = "s".repeat(64);

  test("hashes raw access tokens without retaining the capability", () => {
    const token = Buffer.alloc(32, 7).toString("base64url");
    const hash = hashReviewAccessToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hashReviewAccessToken(token)).toBe(hash);
  });

  test("issues a round-scoped expiring session and rejects tampering", () => {
    const issued = issueReviewSession({ roundId: crypto.randomUUID(), guestId: crypto.randomUUID(), grant: "a".repeat(32), identity: "Client reviewer", subject: crypto.randomUUID() }, secret, new Date("2026-08-30T00:00:00Z"));
    expect(verifyReviewSession(issued, secret, new Date("2026-08-30T01:00:00Z")).identity).toBe("Client reviewer");
    expect(() => verifyReviewSession(`${issued.slice(0, -1)}x`, secret)).toThrow();
    expect(() => verifyReviewSession(issued, secret, new Date("2026-08-31T00:00:00Z"))).toThrow();
  });

  test("uses Argon2id for an optional passcode", async () => {
    const hash = await hashReviewPasscode("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyReviewPasscode("correct horse battery staple", hash)).toBe(true);
    expect(await verifyReviewPasscode("wrong", hash)).toBe(false);
  });

  test("derives terminal and decision states without mutating the stored round", () => {
    const open = { status: "open", revokedAt: null, expiresAt: null, decision: null, items: [] };
    expect(deriveReviewRoundStatus({ ...open, decision: "approved" })).toBe("approved");
    expect(deriveReviewRoundStatus({ ...open, items: [{ currentDecision: "changes_requested" }] })).toBe("changes_requested");
    expect(deriveReviewRoundStatus({ ...open, expiresAt: new Date("2026-01-01T00:00:00Z") }, new Date("2026-01-02T00:00:00Z"))).toBe("expired");
    expect(deriveReviewRoundStatus({ ...open, revokedAt: new Date("2026-01-01T00:00:00Z"), decision: "approved" })).toBe("revoked");
  });

	test("reads the approval default from the frozen Brand Profile snapshot", () => {
		const snapshot = {
			version: 1,
			profileId: crypto.randomUUID(),
			profileRevision: 3,
			name: "Launch brand",
			identity: {
				primaryColor: "#101828",
				secondaryColor: "#F2F4F7",
				accentColor: "#155EEF",
				primaryLogoAssetId: null,
				alternateLogoAssetId: null,
			},
			voice: {
				audience: "",
				tone: [],
				preferredTerms: [],
				blockedTerms: [],
				hashtagGuidance: "",
			},
			approvalRule: "approval_required",
			style: null,
		};

		expect(brandApprovalRequiredByDefault(snapshot)).toBe(true);
		expect(brandApprovalRequiredByDefault({ ...snapshot, approvalRule: "none" })).toBe(false);
		expect(brandApprovalRequiredByDefault(null)).toBe(false);
	});
});
