import { describe, expect, test } from "bun:test";
import { audioAssetLicenseSchema, listAudioAssetsQuerySchema } from "./audio-asset";

describe("audio library validators", () => {
  test("licence accepts exactly the curated licences", () => {
    expect(audioAssetLicenseSchema.options).toEqual(["cc0", "cc_by_4"]);
    expect(audioAssetLicenseSchema.safeParse("cc_by_3").success).toBe(false);
  });

  test("list queries stay strict and keep the 30-row default page", () => {
    expect(listAudioAssetsQuerySchema.parse({ kind: "sfx" })).toMatchObject({ kind: "sfx", scope: "all", limit: 30, offset: 0 });
    expect(listAudioAssetsQuerySchema.safeParse({ kind: "sfx", license: "cc0" }).success).toBe(false);
  });
});
