import { describe, expect, test } from "bun:test";
import {
  assertBrandApplicationAllowed,
  assertBrandMutationAllowed,
  brandOwnerStoragePrefix,
  resolveBrandOwner,
} from "./brand-ownership";
import {
  assertFinalizedVisualObject,
  visualAssetKindForContentType,
} from "./visual-asset.service";
import { parseBrandFontHeader } from "./brand-font.service";

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
  test("stores Creator profiles in personal ownership and Business profiles in workspace ownership", () => {
    expect(resolveBrandOwner(personalScope)).toEqual({ userId: "owner", workspaceId: null });
    expect(resolveBrandOwner({ ...personalScope, pricingTier: "business", isPersonalWorkspace: false })).toEqual({ userId: null, workspaceId: "personal-workspace" });
  });

  test("uses non-overlapping tenant upload prefixes", () => {
    expect(brandOwnerStoragePrefix(personalScope, "visual-assets")).toBe("visual-assets/owner/");
    expect(brandOwnerStoragePrefix({ ...personalScope, pricingTier: "business", isPersonalWorkspace: false }, "brand-fonts")).toBe("workspaces/personal-workspace/brand-fonts/");
  });

  test("enforces brand.manage, active workspace status, and plan entitlement", () => {
    expect(() => assertBrandMutationAllowed(personalScope, "brand.profiles")).not.toThrow();
    expect(() => assertBrandMutationAllowed({ ...personalScope, role: "viewer" }, "brand.profiles")).toThrow();
    expect(() => assertBrandMutationAllowed({ ...personalScope, status: "restricted" }, "brand.profiles")).toThrow();
    expect(() => assertBrandMutationAllowed({ ...personalScope, pricingTier: "free" }, "brand.profiles")).toThrow();
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
});

describe("font parsing", () => {
  test("rejects collections, unknown signatures, and truncated files with valid signatures", () => {
    expect(() => parseBrandFontHeader(Buffer.from("ttcf"))).toThrow();
    expect(() => parseBrandFontHeader(Buffer.from("nope"))).toThrow();
    expect(() => parseBrandFontHeader(Buffer.from([0x00, 0x01, 0x00, 0x00]))).toThrow();
    expect(() => parseBrandFontHeader(Buffer.from("OTTO"))).toThrow();
    expect(() => parseBrandFontHeader(Buffer.from("wOF2"))).toThrow();
  });
});
