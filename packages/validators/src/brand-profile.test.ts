import { describe, expect, test } from "bun:test";
import {
  brandFontFinalizeSchema,
  brandFontUploadSchema,
  brandProfileCreateSchema,
  brandProfileMembershipSchema,
  brandProfileProjectApplicationSchema,
  brandProfileSnapshotSchema,
  brandProfileUpdateSchema,
  visualAssetFinalizeSchema,
  visualAssetUploadSchema,
} from "./brand-profile";

const fingerprint = "a".repeat(64);

describe("Brand Profile contracts", () => {
  test("validates the immutable project profile snapshot, including its frozen style", () => {
    const parsed = brandProfileSnapshotSchema.parse({
      version: 1,
      profileId: "10000000-0000-4000-8000-000000000001",
      profileRevision: 4,
      name: "Northstar",
      identity: {},
      voice: {},
      approvalRule: "approval_required",
      style: {
        templateId: "20000000-0000-4000-8000-000000000002",
        captionPreset: {},
        logoStorageKey: null,
        logoPosition: "bot-right",
        logoOpacity: 80,
        logoScalePct: 15,
        primaryColor: "#FFFFFF",
        secondaryColor: "#00FF88",
        accentColor: null,
      },
    });

    expect(parsed.profileRevision).toBe(4);
    expect(parsed.style?.captionPreset.fontName).toBeTruthy();
    expect(() => brandProfileSnapshotSchema.parse({ ...parsed, arbitrary: true })).toThrow();
  });

  test("normalizes identity and voice guidance at creation", () => {
    const parsed = brandProfileCreateSchema.parse({
      name: "  Northstar Coffee  ",
      slug: "northstar-coffee",
      identity: { primaryColor: "#102A43", secondaryColor: "#F0B429" },
      voice: {
        audience: "Independent café owners",
        tone: ["warm", "specific"],
        preferredTerms: ["coffee bar"],
        blockedTerms: ["cheap"],
        hashtagGuidance: "Use two local tags",
      },
    });
    expect(parsed.name).toBe("Northstar Coffee");
    expect(parsed.voice?.tone).toEqual(["warm", "specific"]);
  });

  test("requires optimistic concurrency on profile updates", () => {
    expect(() => brandProfileUpdateSchema.parse({ name: "New name" })).toThrow();
    expect(brandProfileUpdateSchema.parse({ revision: 4, name: "New name" }).revision).toBe(4);
  });

  test("accepts supported visual uploads and rejects SVG", () => {
    expect(visualAssetUploadSchema.parse({ contentType: "video/quicktime", sizeBytes: 2048 }).contentType).toBe("video/quicktime");
    expect(() => visualAssetUploadSchema.parse({ contentType: "image/svg+xml", sizeBytes: 2048 })).toThrow();
    expect(visualAssetFinalizeSchema.parse({
      key: "workspaces/4d119c8d-acde-4d95-82a4-0e61210e61db/visual-assets/logo.webp",
      contentType: "image/webp",
      sizeBytes: 2048,
      fingerprint,
      title: "Primary logo",
    }).fingerprint).toBe(fingerprint);
  });

  test("requires font licensing and supports bounded font formats", () => {
    expect(() => brandFontUploadSchema.parse({ contentType: "font/ttf", sizeBytes: 1024, licenseConfirmed: false })).toThrow();
    expect(brandFontFinalizeSchema.parse({
      key: "workspaces/4d119c8d-acde-4d95-82a4-0e61210e61db/brand-fonts/display.woff2",
      contentType: "font/woff2",
      sizeBytes: 1024,
      fingerprint,
      family: "Archivo",
      style: "Normal",
      weight: 700,
      licenseConfirmed: true,
    }).weight).toBe(700);
  });

  test("uses typed profile membership roles", () => {
    expect(brandProfileMembershipSchema.parse({ kind: "font", resourceId: "4d119c8d-acde-4d95-82a4-0e61210e61db", role: "display", position: 0 }).role).toBe("display");
    expect(() => brandProfileMembershipSchema.parse({ kind: "font", resourceId: "4d119c8d-acde-4d95-82a4-0e61210e61db", role: "logo", position: 0 })).toThrow();
  });

  test("strictly validates project profile application identifiers", () => {
    const input = {
      projectId: "f9f090ac-fb8f-4d6a-a9d7-c30f1283d98d",
      profileId: "31a08ed5-b5ec-4caf-aeb7-458c3226797e",
      templateId: null,
    };
    expect(brandProfileProjectApplicationSchema.parse(input)).toEqual(input);
    expect(() =>
      brandProfileProjectApplicationSchema.parse({
        ...input,
        profileId: "not-a-profile-id",
      }),
    ).toThrow();
  });
});
