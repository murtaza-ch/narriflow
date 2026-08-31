import { describe, expect, test } from "bun:test";
import {
  assertBrandApplicationAllowed,
  assertBrandMutationAllowed,
  brandOwnerWhereForWorkspace,
  brandOwnerStoragePrefix,
  resolveBrandOwner,
  resolveBrandOwnerForWorkspace,
} from "./brand-ownership";
import {
  assertFinalizedVisualObject,
  assertSceneVisualAssetReferences,
  visualAssetKindForContentType,
} from "./visual-asset.service";
import {
  assertSceneBrandFontReferences,
  parseBrandFontHeader,
} from "./brand-font.service";

const personalScope = {
  actorUserId: "actor",
  workspaceId: "personal-workspace",
  workspaceOwnerUserId: "owner",
  role: "owner" as const,
  status: "active" as const,
  pricingTier: "creator",
  isPersonalWorkspace: true,
};

describe("brand ownership", () => {
	test("keeps personal Brand ownership stable across plan transitions", () => {
		for (const pricingTier of ["creator", "pro", "business", "free"]) {
			expect(resolveBrandOwner({ ...personalScope, pricingTier })).toEqual({
				userId: "owner",
				workspaceId: null,
			});
		}
	});

  test("keeps team Brand ownership stable across plan transitions", () => {
		for (const pricingTier of ["business", "pro", "free"]) {
			expect(
				resolveBrandOwner({ ...personalScope, pricingTier, isPersonalWorkspace: false }),
			).toEqual({ userId: null, workspaceId: "personal-workspace" });
		}
	});

	test("uses non-overlapping tenant upload prefixes", () => {
		expect(brandOwnerStoragePrefix(personalScope, "visual-assets")).toBe("visual-assets/owner/");
		expect(
			brandOwnerStoragePrefix(
				{ ...personalScope, pricingTier: "business" },
				"brand-fonts",
			),
		).toBe("brand-fonts/owner/");
		expect(brandOwnerStoragePrefix({ ...personalScope, pricingTier: "business", isPersonalWorkspace: false }, "brand-fonts")).toBe("workspaces/personal-workspace/brand-fonts/");
	});

  test("enforces brand.manage, active workspace status, and plan entitlement", () => {
    expect(() => assertBrandMutationAllowed(personalScope, "brand.profiles")).not.toThrow();
    expect(() => assertBrandMutationAllowed({ ...personalScope, role: "viewer" }, "brand.profiles")).toThrow();
    expect(() => assertBrandMutationAllowed({ ...personalScope, status: "restricted" }, "brand.profiles")).toThrow();
    expect(() => assertBrandMutationAllowed({ ...personalScope, pricingTier: "free" }, "brand.profiles")).toThrow();
  });

  test("resolves database Workspace facts without plan input", () => {
    expect(
      resolveBrandOwnerForWorkspace({
        workspaceId: "personal-workspace",
        personalOwnerUserId: "owner",
      }),
    ).toEqual({ userId: "owner", workspaceId: null });
    expect(
      resolveBrandOwnerForWorkspace({
        workspaceId: "team-workspace",
        personalOwnerUserId: null,
      }),
    ).toEqual({ userId: null, workspaceId: "team-workspace" });
  });

  test("builds a stable owner filter from database Workspace facts", () => {
    expect(
      brandOwnerWhereForWorkspace({
        workspaceId: "personal-workspace",
        personalOwnerUserId: "owner",
      }),
    ).toEqual({ userId: "owner" });
    expect(
      brandOwnerWhereForWorkspace({
        workspaceId: "team-workspace",
        personalOwnerUserId: null,
      }),
    ).toEqual({ workspaceId: "team-workspace" });
  });

  test("allows active editors to apply profiles but blocks downgrade and free application", () => {
    expect(() =>
      assertBrandApplicationAllowed({ ...personalScope, role: "editor" }),
    ).not.toThrow();
    expect(() =>
      assertBrandApplicationAllowed({ ...personalScope, status: "restricted" }),
    ).toThrow();
    expect(() =>
      assertBrandApplicationAllowed({ ...personalScope, pricingTier: "free" }),
    ).toThrow();
    const downgradedSharedScope = {
      ...personalScope,
      pricingTier: "pro",
      isPersonalWorkspace: false,
    };
    expect(() =>
      assertBrandMutationAllowed(downgradedSharedScope, "brand.profiles"),
    ).toThrow();
    expect(() =>
      assertBrandApplicationAllowed(downgradedSharedScope),
    ).toThrow();
  });
});

describe("visual object verification", () => {
  test("classifies image and video MIME types", () => {
    expect(visualAssetKindForContentType("image/webp")).toBe("image");
    expect(visualAssetKindForContentType("video/quicktime")).toBe("video");
  });

  test("rejects missing, MIME-mismatched, size-mismatched, and failed probes", () => {
    const declared = { contentType: "image/png" as const, sizeBytes: 128 };
    expect(() => assertFinalizedVisualObject(declared, null, null)).toThrow();
    const validProbe = { kind: "image" as const, contentType: "image/png" as const, width: 1, height: 1, durationSec: null };
    expect(() => assertFinalizedVisualObject(declared, { contentType: "image/jpeg", sizeBytes: 128 }, validProbe)).toThrow();
    expect(() => assertFinalizedVisualObject(declared, { contentType: "image/png", sizeBytes: 127 }, validProbe)).toThrow();
    expect(() => assertFinalizedVisualObject(declared, { contentType: "image/png", sizeBytes: 128 }, null)).toThrow();
    expect(() => assertFinalizedVisualObject(declared, { contentType: "image/png", sizeBytes: 128 }, { ...validProbe, contentType: "image/jpeg" })).toThrow();
  });

  test("binds Scene asset kind, fingerprint, and video trim to the owned asset", () => {
    const assetId = crypto.randomUUID();
    const scene = {
      id: crypto.randomUUID(), schemaVersion: 1 as const, anchorSec: 0, durationSec: 3,
      content: { kind: "video" as const, asset: { kind: "visual_asset" as const, id: assetId, fingerprint: "a".repeat(64) }, sourceStartSec: 0, sourceEndSec: 3, fit: "cover" as const, backgroundColor: "#000000", muted: false, volume: 100 },
      motion: { entrance: "none" as const, exit: "none" as const }, templateSnapshot: null,
    };
    const asset = { id: assetId, kind: "video" as const, fingerprint: "a".repeat(64), durationSec: 3 };
    expect(() => assertSceneVisualAssetReferences([scene], [asset])).not.toThrow();
    expect(() => assertSceneVisualAssetReferences([{ ...scene, content: { ...scene.content, sourceEndSec: 999 } }], [asset])).toThrow();
    expect(() => assertSceneVisualAssetReferences([scene], [{ ...asset, fingerprint: "b".repeat(64) }])).toThrow();
    expect(() => assertSceneVisualAssetReferences([scene], [{ ...asset, kind: "image", durationSec: null }])).toThrow();
  });
});

describe("font parsing", () => {
  test("binds a text Scene to the exact retained Brand font identity", () => {
    const fontId = crypto.randomUUID();
    const scene = {
      id: crypto.randomUUID(), schemaVersion: 1 as const, anchorSec: 0, durationSec: 2,
      content: { kind: "text" as const, text: "Opening", fontFamily: "Narriflow Display", fontAsset: { kind: "brand_font" as const, id: fontId, fingerprint: "a".repeat(64) }, color: "#FFFFFF", backgroundColor: "#111827" },
      motion: { entrance: "fade" as const, exit: "fade" as const }, templateSnapshot: null,
    };
    const font = { id: fontId, family: "Narriflow Display", fingerprint: "a".repeat(64) };
    expect(() => assertSceneBrandFontReferences([scene], [font])).not.toThrow();
    expect(() => assertSceneBrandFontReferences([scene], [{ ...font, family: "Wrong Font" }])).toThrow();
    expect(() => assertSceneBrandFontReferences([scene], [{ ...font, fingerprint: "b".repeat(64) }])).toThrow();
  });

  test("rejects collections, unknown signatures, and truncated files with valid signatures", () => {
    expect(() => parseBrandFontHeader(Buffer.from("ttcf"))).toThrow();
    expect(() => parseBrandFontHeader(Buffer.from("nope"))).toThrow();
    expect(() => parseBrandFontHeader(Buffer.from([0x00, 0x01, 0x00, 0x00]))).toThrow();
    expect(() => parseBrandFontHeader(Buffer.from("OTTO"))).toThrow();
    expect(() => parseBrandFontHeader(Buffer.from("wOF2"))).toThrow();
  });
});
