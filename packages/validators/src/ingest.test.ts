import { describe, expect, test } from "bun:test";
import { rssImportSchema } from "./ingest";

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
});
