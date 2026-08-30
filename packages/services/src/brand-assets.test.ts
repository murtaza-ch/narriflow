import { describe, expect, test } from "bun:test";
import {
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
});

describe("visual object verification", () => {
  test("classifies image and video MIME types", () => {
    expect(visualAssetKindForContentType("image/webp")).toBe("image");
    expect(visualAssetKindForContentType("video/quicktime")).toBe("video");
  });

  test("rejects missing, MIME-mismatched, size-mismatched, and failed probes", () => {
    const declared = { contentType: "image/png" as const, sizeBytes: 128 };
    expect(() => assertFinalizedVisualObject(declared, null, null)).toThrow();
    expect(() => assertFinalizedVisualObject(declared, { contentType: "image/jpeg", sizeBytes: 128 }, { kind: "image", width: 1, height: 1, durationSec: null })).toThrow();
    expect(() => assertFinalizedVisualObject(declared, { contentType: "image/png", sizeBytes: 127 }, { kind: "image", width: 1, height: 1, durationSec: null })).toThrow();
    expect(() => assertFinalizedVisualObject(declared, { contentType: "image/png", sizeBytes: 128 }, null)).toThrow();
  });
});

describe("font parsing", () => {
  test("accepts standalone sfnt and WOFF2 headers and rejects collections or malformed files", () => {
    expect(parseBrandFontHeader(Buffer.from([0x00, 0x01, 0x00, 0x00]))).toBe("ttf");
    expect(parseBrandFontHeader(Buffer.from("OTTO"))).toBe("otf");
    expect(parseBrandFontHeader(Buffer.from("wOF2"))).toBe("woff2");
    expect(() => parseBrandFontHeader(Buffer.from("ttcf"))).toThrow();
    expect(() => parseBrandFontHeader(Buffer.from("nope"))).toThrow();
  });
});
