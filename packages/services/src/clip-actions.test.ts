import { describe, expect, test } from "bun:test";
import {
  ClipActionError,
  CLIP_TITLE_SYSTEM_PROMPT,
  buildClipTitleUserPrompt,
  clipDuplicatePreviewStorageKey,
  clipDuplicateRenderStorageKey,
  planClipStorageDeletion,
  type ClipStorageSnapshot,
} from "./clip.service";
import { buildCopySource } from "./r2-storage";

function storageSnapshot(
  overrides: Partial<ClipStorageSnapshot> = {},
): ClipStorageSnapshot {
  return {
    previewStorageKey: "projects/p1/previews/c1/attempt-1.mp4",
    renderStorageKeys: ["projects/p1/renders/c1/9x16.mp4"],
    dubStorageKeys: [],
    ...overrides,
  };
}

describe("planClipStorageDeletion", () => {
  test("collects renders, dubs, and the preview proxy into one list", () => {
    const keys = planClipStorageDeletion(
      storageSnapshot({
        renderStorageKeys: [
          "projects/p1/renders/c1/9x16.mp4",
          "projects/p1/renders/c1/1x1.mp4",
        ],
        dubStorageKeys: [
          "projects/p1/dubs/c1/d1.mp3",
          "projects/p1/dubs/c1/d1.mp4",
        ],
      }),
    );

    expect(keys.sort()).toEqual(
      [
        "projects/p1/renders/c1/9x16.mp4",
        "projects/p1/renders/c1/1x1.mp4",
        "projects/p1/dubs/c1/d1.mp3",
        "projects/p1/dubs/c1/d1.mp4",
        "projects/p1/previews/c1/attempt-1.mp4",
        // The peaks sidecar (derived key, no own column) must be swept too.
        "projects/p1/previews/c1/attempt-1.peaks.json",
      ].sort(),
    );
  });

  test("includes the derived peaks sidecar key alongside the preview proxy", () => {
    const keys = planClipStorageDeletion(storageSnapshot());

    expect(keys).toContain("projects/p1/previews/c1/attempt-1.peaks.json");
  });

  test("never throws for a legacy/malformed previewStorageKey that doesn't end in .mp4", () => {
    const keys = planClipStorageDeletion(
      storageSnapshot({
        previewStorageKey: "projects/p1/previews/c1/legacy.mov",
      }),
    );

    expect(keys).toContain("projects/p1/previews/c1/legacy.mov");
    expect(keys).not.toContain(null);
  });

  test("drops nulls — an unrendered, un-dubbed clip yields nothing to delete", () => {
    expect(
      planClipStorageDeletion({
        previewStorageKey: null,
        renderStorageKeys: [null, null],
        dubStorageKeys: [null, null],
      }),
    ).toEqual([]);
  });

  test("dedupes repeated keys so a delete never round-trips twice", () => {
    const keys = planClipStorageDeletion(
      storageSnapshot({
        renderStorageKeys: [
          "projects/p1/renders/c1/9x16.mp4",
          "projects/p1/renders/c1/9x16.mp4",
        ],
        dubStorageKeys: ["projects/p1/previews/c1/attempt-1.mp4"],
      }),
    );

    // 9x16.mp4, attempt-1.mp4 (deduped preview/dub), attempt-1.peaks.json.
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("duplicate destination keys", () => {
  test("render key is scoped to the NEW clip id, never the source's", () => {
    const key = clipDuplicateRenderStorageKey("p1", "copy-1", "9:16");

    expect(key).toBe("projects/p1/renders/copy-1/9x16.mp4");
    expect(key).not.toContain("c1");
  });

  test("each aspect ratio gets its own slugged key", () => {
    const keys = (["9:16", "16:9", "1:1", "4:5"] as const).map((ratio) =>
      clipDuplicateRenderStorageKey("p1", "copy-1", ratio),
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  test("preview key is attempt-scoped, so two duplicates never collide", () => {
    const first = clipDuplicatePreviewStorageKey("p1", "copy-1", "attempt-a");
    const second = clipDuplicatePreviewStorageKey("p1", "copy-1", "attempt-b");

    expect(first).toBe("projects/p1/previews/copy-1/attempt-a.mp4");
    expect(first).not.toBe(second);
  });

  test("a duplicate's keys never equal the source clip's", () => {
    // The whole point of copying rather than sharing: delete-by-key on either
    // clip must not touch the other's bytes.
    const source = clipDuplicateRenderStorageKey("p1", "c1", "9:16");
    const copy = clipDuplicateRenderStorageKey("p1", "copy-1", "9:16");

    expect(source).not.toBe(copy);
  });
});

describe("buildCopySource", () => {
  test("keeps path separators intact while encoding each segment", () => {
    expect(buildCopySource("bucket", "projects/p1/renders/c1/9x16.mp4")).toBe(
      "bucket/projects/p1/renders/c1/9x16.mp4",
    );
  });

  test("escapes characters that would otherwise break the copy source", () => {
    expect(buildCopySource("bucket", "projects/p1/my clip+v2.mp4")).toBe(
      "bucket/projects/p1/my%20clip%2Bv2.mp4",
    );
  });
});

describe("clip title prompt", () => {
  const base = {
    languageCode: "en" as string | null,
    category: "hook",
    title: "The Wrong Technology",
    hookText: "the choice of our technology was absolutely wrong",
    payoffText: null,
    spokenText: "The thing that most people don't believe is that the choice of our technology was absolutely wrong.",
  };

  test("states the transcript's language code verbatim", () => {
    // The regression this guards: the language was never passed at all, so the
    // model inferred one from a short slice and returned Spanish for English
    // audio.
    const prompt = buildClipTitleUserPrompt(base);

    expect(prompt).toContain("provider language code en");
    expect(prompt.split("\n")[0]).toStartWith("Source language:");
  });

  test("carries a non-English code through unchanged", () => {
    expect(buildClipTitleUserPrompt({ ...base, languageCode: "hi" })).toContain(
      "provider language code hi",
    );
    expect(buildClipTitleUserPrompt({ ...base, languageCode: "es" })).toContain(
      "provider language code es",
    );
  });

  test("falls back to inferring one consistent language when the code is unknown", () => {
    const prompt = buildClipTitleUserPrompt({ ...base, languageCode: null });

    expect(prompt).toContain("unknown");
    expect(prompt).toContain("that one language for every option");
    expect(prompt).not.toContain("provider language code");
  });

  test("system prompt forbids translating and mixing languages", () => {
    expect(CLIP_TITLE_SYSTEM_PROMPT).toContain("Never translate");
    expect(CLIP_TITLE_SYSTEM_PROMPT).toContain("exactly one language");
    expect(CLIP_TITLE_SYSTEM_PROMPT).toContain("that language's own script");
  });

  test("omits optional lines rather than emitting empty ones", () => {
    const prompt = buildClipTitleUserPrompt({
      ...base,
      title: null,
      payoffText: null,
    });

    expect(prompt).not.toContain("Current title:");
    expect(prompt).not.toContain("Payoff:");
    expect(prompt.split("\n").every((line) => line.trim().length > 0)).toBe(true);
  });

  test("falls back to the hook when the clip has no transcript text", () => {
    const prompt = buildClipTitleUserPrompt({ ...base, spokenText: "" });

    expect(prompt).toContain(`Spoken text: ${base.hookText}`);
  });
});

describe("ClipActionError", () => {
  test("carries the code the API maps to user-facing copy", () => {
    const error = new ClipActionError("clip_has_scheduled_posts", "2 posts");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("clip_has_scheduled_posts");
    expect(error.message).toBe("2 posts");
  });
});
