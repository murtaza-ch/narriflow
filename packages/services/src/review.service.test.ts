import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	brandApprovalRequiredByDefault,
  deriveReviewRoundStatus,
  hashReviewAccessToken,
  hashReviewPasscode,
  issueReviewSession,
  verifyReviewPasscode,
  verifyReviewSession,
  decodeReviewSelection,
  encodeReviewSelection,
  reviewRoundSummary,
  reviewService,
  validateReviewHandoffSelection,
  type ReviewHandoffExport,
} from "./review.service";
import { workspaceService } from "./workspace.service";

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

describe("Review Room plan boundary", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
  test("Pro's integration access does not include Review Rooms", async () => {
    for (const pricingTier of ["free", "creator", "pro"] as const) {
      spies.push(spyOn(workspaceService, "requireActor").mockResolvedValue({ actorUserId: "user-1", workspaceId: "workspace-1", workspaceName: "Studio",
        workspaceOwnerUserId: "user-1", role: "owner", status: "active", pricingTier, isPersonalWorkspace: true } as never));
      await expect(reviewService.prepareHandoff({ actorUserId: "user-1", workspaceId: "workspace-1" }, [])).rejects.toMatchObject({
        code: "plan_feature_required", kind: "payment_required", details: { feature: "review.rooms", currentTier: pricingTier, requiredTier: "business" },
      });
      await expect(reviewService.createRound({ actorUserId: "user-1", workspaceId: "workspace-1", projectId: "project-1", pricingTier }, {})).rejects.toMatchObject({ code: "plan_feature_required" });
      spies.pop()?.mockRestore();
    }
  });
});

describe("assistant review handoff", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const ready = (n: number, patch: Partial<ReviewHandoffExport> = {}): ReviewHandoffExport => ({ id: uuid(n), projectId: uuid(100), clipId: uuid(200 + n), status: "ready",
    editorRevision: 3, currentEditorRevision: 3, completedVariantIds: [uuid(300 + n)], ...patch });
  const pick = (n: number) => ({ exportId: uuid(n), variantIds: [uuid(300 + n)] });

  test("normalizes a valid selection for the composer", () => {
    expect(validateReviewHandoffSelection([pick(1), pick(2)], [ready(1), ready(2)])).toEqual({ projectId: uuid(100), items: [
      { clipId: uuid(201), exportId: uuid(1), editorRevision: 3, variantIds: [uuid(301)] },
      { clipId: uuid(202), exportId: uuid(2), editorRevision: 3, variantIds: [uuid(302)] },
    ] });
  });
  test("refuses incomplete, stale, foreign, mixed-project, and duplicate-clip selections", () => {
    const refuse = (items: Array<{ exportId: string; variantIds: string[] }>, rows: ReviewHandoffExport[], code: string) =>
      expect(() => validateReviewHandoffSelection(items, rows)).toThrow(expect.objectContaining({ code }));
    refuse([pick(1)], [ready(1, { status: "partial_ready" })], "review_item_stale");
    refuse([pick(1)], [ready(1, { currentEditorRevision: 4 })], "review_item_stale");
    refuse([pick(1)], [], "review_item_stale");
    refuse([{ exportId: uuid(1), variantIds: [uuid(999)] }], [ready(1)], "review_item_stale");
    refuse([pick(1), pick(2)], [ready(1), ready(2, { projectId: uuid(101) })], "review_items_mixed_projects");
    refuse([pick(1), pick(2)], [ready(1), ready(2, { clipId: uuid(201) })], "review_items_duplicate");
  });
  test("composer preselection round-trips and ignores malformed entries", () => {
    const encoded = encodeReviewSelection([pick(1), pick(2)]);
    expect(decodeReviewSelection(encoded)).toEqual([pick(1), pick(2)]);
    expect(decodeReviewSelection(`${encoded};not-a-uuid:x;${uuid(9)}:`)).toEqual([pick(1), pick(2)]);
    expect(decodeReviewSelection(undefined)).toEqual([]);
  });
  test("round summaries carry decisions and comment counts but no access secrets or emails", () => {
    const row = {
      id: uuid(1), projectId: uuid(100), revision: 2, title: "Client cut", status: "open", decision: null,
      sentAt: new Date("2026-10-07T10:00:00Z"), expiresAt: null, revokedAt: null,
      accessTokenHash: "token-hash-secret", deliveryTokenEncrypted: "delivery-secret", passcodeHash: "passcode-secret", recipientEmails: ["client@example.test"],
      items: [{ id: uuid(2), clipId: uuid(3), exportId: uuid(4), editorRevision: 1, required: true, currentDecision: "changes_requested", clip: { title: "Hook" } }],
      comments: [{ itemId: uuid(2), body: "secret body", authorName: "client@example.test" }, { itemId: null }],
    };
    const summary = reviewRoundSummary(row, new Date("2026-10-07T12:00:00Z"));
    expect(summary).toMatchObject({ status: "changes_requested", generalCommentCount: 1, items: [{ decision: "changes_requested", commentCount: 1 }] });
    const serialized = JSON.stringify(summary);
    for (const secret of ["token-hash-secret", "delivery-secret", "passcode-secret", "client@example.test", "secret body"]) expect(serialized).not.toContain(secret);
  });
});
