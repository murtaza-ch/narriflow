import { describe, expect, test } from "bun:test";
import {
  createClipExportSchema,
  createClipShareLinkSchema,
} from "./clip-export";

describe("createClipExportSchema", () => {
  test("applies production defaults", () => {
    expect(createClipExportSchema.parse({ expectedRevision: 0 })).toEqual({
      expectedRevision: 0,
      aspectRatios: ["9:16"],
      resolution: "1080p",
    });
  });

  test("rejects stale-shape and abusive requests", () => {
    expect(createClipExportSchema.safeParse({ expectedRevision: -1 }).success).toBe(false);
    expect(createClipExportSchema.safeParse({ expectedRevision: 1, aspectRatios: [] }).success).toBe(false);
    expect(
      createClipExportSchema.safeParse({
        expectedRevision: 1,
        aspectRatios: ["9:16", "1:1", "16:9", "4:5", "9:16"],
      }).success,
    ).toBe(false);
    expect(createClipExportSchema.safeParse({ expectedRevision: 1, resolution: "4k" }).success).toBe(false);
  });
});

describe("createClipShareLinkSchema", () => {
  test("defaults to a seven-day link and only accepts supported expiry policies", () => {
    expect(createClipShareLinkSchema.parse({})).toEqual({ expiresInDays: 7 });
    expect(createClipShareLinkSchema.parse({ expiresInDays: null })).toEqual({ expiresInDays: null });
    expect(createClipShareLinkSchema.safeParse({ expiresInDays: 365 }).success).toBe(false);
  });
});
