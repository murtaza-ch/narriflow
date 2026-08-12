import { describe, expect, test } from "bun:test";
import type { RssEpisodeInput } from "@narriflow/validators";
import {
  autopilotRetryDelayMs,
  selectAutopilotEpisodes,
} from "./autopilot.service";

function episode(id: string, publishedAt: string): RssEpisodeInput {
  return {
    id,
    title: id,
    enclosureUrl: `https://cdn.example/${id}.mp3`,
    publishedAt,
    durationSeconds: 60,
    mimeType: "audio/mpeg",
  };
}

const episodes = [
  episode("newest", "2026-08-12T00:00:00.000Z"),
  episode("newer", "2026-08-11T00:00:00.000Z"),
  episode("cursor", "2026-08-10T00:00:00.000Z"),
  episode("old", "2026-08-09T00:00:00.000Z"),
];

describe("selectAutopilotEpisodes", () => {
  test("future-only initialization never imports the existing catalog", () => {
    expect(
      selectAutopilotEpisodes(episodes, new Set(), {
        initializedAt: null,
        initialImportMode: "future_only",
        initialImportCount: 3,
        maxEpisodesPerRun: 3,
        lastSeenEpisodeId: null,
        lastSeenPublishedAt: null,
      }),
    ).toEqual({ episodes: [], shouldAdvanceCursor: true });
  });

  test("latest mode performs exactly one bounded initial backfill", () => {
    const selected = selectAutopilotEpisodes(episodes, new Set(), {
      initializedAt: null,
      initialImportMode: "latest",
      initialImportCount: 2,
      maxEpisodesPerRun: 5,
      lastSeenEpisodeId: null,
      lastSeenPublishedAt: null,
    });
    expect(selected.episodes.map(({ id }) => id)).toEqual(["newest", "newer"]);
    expect(selected.shouldAdvanceCursor).toBe(true);
  });

  test("selects only entries before the durable cursor", () => {
    const selected = selectAutopilotEpisodes(episodes, new Set(), {
      initializedAt: new Date(),
      initialImportMode: "future_only",
      initialImportCount: 3,
      maxEpisodesPerRun: 5,
      lastSeenEpisodeId: "cursor",
      lastSeenPublishedAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    expect(selected.episodes.map(({ id }) => id)).toEqual(["newest", "newer"]);
    expect(selected.shouldAdvanceCursor).toBe(true);
  });

  test("does not advance past a multi-batch backlog", () => {
    const first = selectAutopilotEpisodes(episodes, new Set(), {
      initializedAt: new Date(),
      initialImportMode: "future_only",
      initialImportCount: 3,
      maxEpisodesPerRun: 1,
      lastSeenEpisodeId: "cursor",
      lastSeenPublishedAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    expect(first.episodes.map(({ id }) => id)).toEqual(["newest"]);
    expect(first.shouldAdvanceCursor).toBe(false);

    const second = selectAutopilotEpisodes(episodes, new Set(["newest"]), {
      initializedAt: new Date(),
      initialImportMode: "future_only",
      initialImportCount: 3,
      maxEpisodesPerRun: 1,
      lastSeenEpisodeId: "cursor",
      lastSeenPublishedAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    expect(second.episodes.map(({ id }) => id)).toEqual(["newer"]);
    expect(second.shouldAdvanceCursor).toBe(true);
  });

  test("falls back to publication time when a rolling feed drops the cursor", () => {
    const selected = selectAutopilotEpisodes(episodes, new Set(), {
      initializedAt: new Date(),
      initialImportMode: "future_only",
      initialImportCount: 3,
      maxEpisodesPerRun: 5,
      lastSeenEpisodeId: "missing",
      lastSeenPublishedAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    expect(selected.episodes.map(({ id }) => id)).toEqual(["newest", "newer"]);
  });
});

describe("autopilotRetryDelayMs", () => {
  test("uses bounded exponential backoff", () => {
    expect(autopilotRetryDelayMs(1, 60)).toBe(60_000);
    expect(autopilotRetryDelayMs(2, 60)).toBe(120_000);
    expect(autopilotRetryDelayMs(20, 60)).toBe(60 * 60_000);
  });
});
