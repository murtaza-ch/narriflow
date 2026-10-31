import type { RssEpisodeInput } from "@narriflow/validators";

export const AUTOPILOT_LEASE_MS = 2 * 60 * 1000;
export const AUTOPILOT_MAX_CONSECUTIVE_FAILURES = 8;

export function autopilotRetryDelayMs(
  consecutiveFailures: number,
  intervalMinutes: number,
) {
  const exponent = Math.max(0, Math.min(10, consecutiveFailures - 1));
  const retryDelay = 60_000 * 2 ** exponent;
  return Math.min(intervalMinutes * 60_000, retryDelay);
}

type EpisodeSelectionRule = {
  initializedAt: Date | null;
  initialImportMode: "future_only" | "latest";
  initialImportCount: number;
  maxEpisodesPerRun: number;
  lastSeenEpisodeId: string | null;
  lastSeenPublishedAt: Date | null;
};

export function selectAutopilotEpisodes(
  episodes: RssEpisodeInput[],
  existingIds: ReadonlySet<string>,
  rule: EpisodeSelectionRule,
): { episodes: RssEpisodeInput[]; shouldAdvanceCursor: boolean } {
  if (!rule.initializedAt) {
    if (rule.initialImportMode === "future_only") {
      return { episodes: [], shouldAdvanceCursor: true };
    }
    return {
      episodes: episodes
        .filter((episode) => !existingIds.has(episode.id))
        .slice(0, Math.min(rule.initialImportCount, rule.maxEpisodesPerRun)),
      // Initial latest-N is an explicit bounded backfill. Older entries are
      // intentionally behind the new cursor and will not churn on later runs.
      shouldAdvanceCursor: true,
    };
  }

  let newWindow: RssEpisodeInput[];
  const cursorIndex = rule.lastSeenEpisodeId
    ? episodes.findIndex((episode) => episode.id === rule.lastSeenEpisodeId)
    : -1;
  if (cursorIndex >= 0) {
    newWindow = episodes.slice(0, cursorIndex);
  } else if (rule.lastSeenPublishedAt) {
    const baseline = rule.lastSeenPublishedAt.getTime();
    newWindow = episodes.filter(
      (episode) =>
        episode.publishedAt !== null &&
        episode.publishedAt !== undefined &&
        Date.parse(episode.publishedAt) > baseline,
    );
  } else {
    // If an undated cursor disappeared from a rolling feed, importing every
    // item would be a surprise backfill. Wait for an identifiable new head.
    newWindow = [];
  }

  const unseen = newWindow.filter((episode) => !existingIds.has(episode.id));
  return {
    episodes: unseen.slice(0, rule.maxEpisodesPerRun),
    shouldAdvanceCursor: unseen.length <= rule.maxEpisodesPerRun,
  };
}

