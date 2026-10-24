import { describe, expect, test } from "bun:test";
import { driveIngestSchema, rssImportSchema } from "./ingest";

describe("driveIngestSchema", () => {
  const valid = { fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123", accessToken: "ya29.token" };

  test("accepts a Picker file with the link intake's optional settings", () => {
    expect(
      driveIngestSchema.parse({
        ...valid,
        title: "Weekly sync",
        brandProfileId: "bc25be61-113c-4fa0-b7a6-6e757270cd94",
        commitToken: "4ac4e6ad-9f29-4cb2-a9ea-35ec85efc332",
        mode: "clip",
        processingStartSec: 0,
        processingEndSec: 90,
      }),
    ).toMatchObject({ fileId: valid.fileId, mode: "clip" });
  });

  test("keeps the file ID to Drive's alphabet so it can't alter the API path", () => {
    for (const fileId of ["", "short", "../files/other-file-id", "id/with/slash-1234", "id?alt=media&x=1"]) {
      expect(driveIngestSchema.safeParse({ ...valid, fileId }).success).toBe(false);
    }
  });

  test("requires a token and rejects fields the browser may not choose", () => {
    expect(driveIngestSchema.safeParse({ fileId: valid.fileId }).success).toBe(false);
    expect(driveIngestSchema.safeParse({ ...valid, accessToken: "" }).success).toBe(false);
    expect(driveIngestSchema.safeParse({ ...valid, url: "https://drive.google.com/x" }).success).toBe(false);
    expect(driveIngestSchema.safeParse({ ...valid, sizeBytes: 5 }).success).toBe(false);
  });
});

describe("rssImportSchema authoritative boundary", () => {
  test("accepts one stable episode ID and an idempotency token", () => {
    expect(
      rssImportSchema.parse({
        rssUrl: "https://feeds.example/show.xml",
        episodeIds: ["stable-id"],
        commitToken: "4ac4e6ad-9f29-4cb2-a9ea-35ec85efc332",
      }),
    ).toMatchObject({ episodeIds: ["stable-id"] });
  });

  test("rejects client-supplied episode metadata", () => {
    expect(
      rssImportSchema.safeParse({
        rssUrl: "https://feeds.example/show.xml",
        episodes: [
          {
            id: "episode",
            title: "Forged",
            enclosureUrl: "https://attacker.example/large.mp4",
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects manual batch imports", () => {
    expect(
      rssImportSchema.safeParse({
        rssUrl: "https://feeds.example/show.xml",
        episodeIds: ["one", "two"],
      }).success,
    ).toBe(false);
  });

  test("states the Brand Profile as an ID or null, and rejects the retired template field", () => {
    const base = { rssUrl: "https://feeds.example/show.xml", episodeIds: ["stable-id"] };
    const brandProfileId = "0b3a4c1e-6a84-4d5f-8c3a-1f2e3d4c5b6a";
    expect(rssImportSchema.parse({ ...base, brandProfileId })).toMatchObject({ brandProfileId });
    expect(rssImportSchema.parse({ ...base, brandProfileId: null })).toMatchObject({ brandProfileId: null });
    expect(rssImportSchema.parse(base).brandProfileId).toBeUndefined();
    expect(rssImportSchema.safeParse({ ...base, brandTemplateId: brandProfileId }).success).toBe(false);
  });
});
