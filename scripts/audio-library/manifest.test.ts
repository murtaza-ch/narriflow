import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { sortEntries, validateManifest } from "./manifest";
import { incompetechAttribution, storageKeyFor } from "./selection";
import type { ManifestEntry } from "./types";

let counter = 0;
function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  counter++;
  const sha256 = createHash("sha256").update(`fixture-${counter}`).digest("hex");
  const kind = overrides.kind ?? "music";
  return {
    kind,
    title: `Title ${counter}`,
    artist: "Someone",
    license: "cc0",
    attribution: null,
    sourceUrl: "https://example.test/a",
    source: "freepd",
    sourceId: `file-${counter}`,
    moods: kind === "music" ? ["Chill"] : ["Click"],
    sortOrder: 1000,
    durationSec: 12.5,
    sha256,
    storageKey: storageKeyFor(kind, sha256),
    retrievedAt: "2026-11-20T10:00:00.000Z",
    ...overrides,
  };
}

function classic(title: string, sortOrder = 1): ManifestEntry {
  return entry({
    title,
    artist: "Kevin MacLeod",
    license: "cc_by_4",
    attribution: incompetechAttribution(title),
    source: "incompetech",
    moods: ["Popular", "Funny"],
    sortOrder,
  });
}

describe("validateManifest", () => {
  test("accepts a well-formed mixed manifest", () => {
    expect(validateManifest([classic("Sneaky Snitch"), entry(), entry({ kind: "sfx" })])).toEqual([]);
  });

  test("titles are unique within a kind but may repeat across kinds", () => {
    expect(validateManifest([entry({ title: "Ding" }), entry({ title: "Ding", kind: "sfx" })])).toEqual([]);
    const errors = validateManifest([entry({ title: "Ding" }), entry({ title: "ding" })]);
    expect(errors.some((error) => error.includes("duplicate title"))).toBe(true);
  });

  test("moods must come from the kind's vocabulary", () => {
    expect(validateManifest([entry({ moods: ["Chill", "Grungy"] })]).join("\n")).toContain('"Grungy" is not an allowed music mood');
    expect(validateManifest([entry({ kind: "sfx", moods: ["Chill"] })]).join("\n")).toContain("not an allowed sfx mood");
    expect(validateManifest([entry({ moods: [] })]).join("\n")).toContain("at least one mood");
  });

  test("an SFX carries exactly one category", () => {
    expect(validateManifest([entry({ kind: "sfx", moods: ["Click", "Pop"] })]).join("\n")).toContain("exactly one category");
  });

  test("attribution is present if and only if the license is cc_by_4", () => {
    const missing = entry({ license: "cc_by_4", attribution: null, sortOrder: 5, moods: ["Popular"] });
    expect(validateManifest([missing]).join("\n")).toContain("cc_by_4 requires attribution");
    const blank = entry({ license: "cc_by_4", attribution: "  ", sortOrder: 5, moods: ["Popular"] });
    expect(validateManifest([blank]).join("\n")).toContain("cc_by_4 requires attribution");
    const extra = entry({ license: "cc0", attribution: "credit me" });
    expect(validateManifest([extra]).join("\n")).toContain("cc0 must not carry attribution");
  });

  test("attribution must name the track", () => {
    const wrong = { ...classic("Real Title"), attribution: incompetechAttribution("Other Title") };
    expect(validateManifest([wrong]).join("\n")).toContain("exactly the Incompetech credit");
  });

  test("a cc_by_4 credit must match the full template, not just start with the title", () => {
    const truncated = { ...classic("Real Title"), attribution: '"Real Title" Kevin MacLeod' };
    expect(validateManifest([truncated]).join("\n")).toContain("exactly the Incompetech credit");
    const wrongLicense = { ...classic("Real Title"), attribution: incompetechAttribution("Real Title").replace("4.0", "3.0") };
    expect(validateManifest([wrongLicense]).join("\n")).toContain("exactly the Incompetech credit");
    expect(validateManifest([classic("Real Title")]).join("\n")).not.toContain("Incompetech credit");
  });

  test("durations must be positive and finite", () => {
    expect(validateManifest([entry({ durationSec: 0 })]).join("\n")).toContain("durationSec must be > 0");
    expect(validateManifest([entry({ durationSec: Number.NaN })]).join("\n")).toContain("durationSec must be > 0");
    expect(validateManifest([entry({ durationSec: -3 })]).join("\n")).toContain("durationSec must be > 0");
  });

  test("CC0 music is capped at the six minute trim", () => {
    expect(validateManifest([entry({ durationSec: 361 })]).join("\n")).toContain("trimmed");
    expect(validateManifest([entry({ durationSec: 360.1 })])).toEqual([]);
  });

  test("storageKey must be derived from the hash and unique", () => {
    expect(validateManifest([entry({ storageKey: "audio-library/music/0000000000000000.mp3" })]).join("\n")).toContain("does not match sha256");
    const a = entry();
    const duplicate = { ...entry(), sha256: a.sha256, storageKey: a.storageKey };
    expect(validateManifest([a, duplicate]).join("\n")).toContain("duplicate storageKey");
    expect(validateManifest([entry({ sha256: "xyz", storageKey: "k" })]).join("\n")).toContain("sha256 is not 64 hex");
  });

  test("Popular tracks use sortOrder 1-99 and nothing else does", () => {
    expect(validateManifest([classic("A", 150)]).join("\n")).toContain("Popular tracks use sortOrder 1-99");
    expect(validateManifest([entry({ sortOrder: 7 })]).join("\n")).toContain("reserved for Popular");
  });

  test("source and retrieval provenance are required", () => {
    expect(validateManifest([entry({ sourceUrl: "ftp://x" })]).join("\n")).toContain("sourceUrl");
    expect(validateManifest([entry({ retrievedAt: "" })]).join("\n")).toContain("retrievedAt");
  });
});

describe("sortEntries", () => {
  test("music by sortOrder then title, SFX by category order then title, music first", () => {
    const sorted = sortEntries([
      entry({ kind: "sfx", title: "Zap", moods: ["Sci-fi"] }),
      entry({ kind: "sfx", title: "Whoosh B", moods: ["Whoosh"] }),
      entry({ title: "Beta" }),
      classic("Second", 2),
      entry({ kind: "sfx", title: "Whoosh A", moods: ["Whoosh"] }),
      classic("First", 1),
      entry({ title: "Alpha" }),
    ]);
    expect(sorted.map((item) => item.title)).toEqual(["First", "Second", "Alpha", "Beta", "Whoosh A", "Whoosh B", "Zap"]);
  });
});
