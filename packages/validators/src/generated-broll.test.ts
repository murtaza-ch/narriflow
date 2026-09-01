import { describe, expect, test } from "bun:test";
import { studioEditsSchema } from "./studio-edits";

describe("generated visual B-roll", () => {
  test("stores only a Visual Asset identity and fingerprint in the editor document", () => {
    const edits = studioEditsSchema.parse({
      visualBroll: [{
        id: "00000000-0000-4000-8000-000000000001",
        asset: {
          kind: "visual_asset",
          id: "00000000-0000-4000-8000-000000000002",
          fingerprint: "a".repeat(64),
        },
        startSec: 3,
        endSec: 7,
        fit: "cover",
      }],
    });

    expect(edits.visualBroll[0]).toMatchObject({ startSec: 3, endSec: 7 });
    expect(JSON.stringify(edits.visualBroll)).not.toContain("http");
  });

  test("rejects overlapping or invalid visual B-roll windows", () => {
    expect(() => studioEditsSchema.parse({
      visualBroll: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          asset: { kind: "visual_asset", id: "00000000-0000-4000-8000-000000000002", fingerprint: "a".repeat(64) },
          startSec: 3,
          endSec: 7,
          fit: "cover",
        },
        {
          id: "00000000-0000-4000-8000-000000000003",
          asset: { kind: "visual_asset", id: "00000000-0000-4000-8000-000000000004", fingerprint: "b".repeat(64) },
          startSec: 6,
          endSec: 8,
          fit: "contain",
        },
      ],
    })).toThrow();
  });
});
