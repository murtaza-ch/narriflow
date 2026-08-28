import type { TranscriptUtterance } from "@narriflow/validators";

export function computeDurationOptimality(
  durationSec: number,
  policy: {
    minDurationSec?: number;
    preferredMinDurationSec?: number;
    preferredMaxDurationSec?: number;
    maxDurationSec?: number;
  } = {},
): number {
  const minDurationSec = policy.minDurationSec ?? 15;
  const preferredMinDurationSec = policy.preferredMinDurationSec ?? 30;
  const preferredMaxDurationSec = policy.preferredMaxDurationSec ?? 60;
  const maxDurationSec = policy.maxDurationSec ?? 120;

  if (
    durationSec >= preferredMinDurationSec &&
    durationSec <= preferredMaxDurationSec
  ) {
    return 100;
  }

  if (durationSec >= minDurationSec && durationSec < preferredMinDurationSec) {
    const span = Math.max(1, preferredMinDurationSec - minDurationSec);
    return Math.round(60 + ((durationSec - minDurationSec) / span) * 40);
  }

  if (durationSec > preferredMaxDurationSec && durationSec <= maxDurationSec) {
    const span = Math.max(1, maxDurationSec - preferredMaxDurationSec);
    return Math.round(100 - ((durationSec - preferredMaxDurationSec) / span) * 60);
  }

  if (durationSec < minDurationSec) {
    return Math.max(20, Math.round((durationSec / minDurationSec) * 60));
  }

  return 20;
}

export function computePacingScore(
  utterances: TranscriptUtterance[],
  durationSec: number,
): number {
  if (durationSec <= 0 || utterances.length === 0) return 50;

  const totalWords = utterances.reduce(
    (sum, utterance) => sum + utterance.text.split(/\s+/).length,
    0,
  );
  const wordsPerSecond = totalWords / durationSec;
  const speakerTurns = utterances.reduce(
    (turns, utterance, index) =>
      index === 0 || utterance.speaker !== utterances[index - 1]!.speaker
        ? turns + 1
        : turns,
    0,
  );
  const turnsPerMinute = (speakerTurns / durationSec) * 60;

  let score = 50;
  if (wordsPerSecond >= 2 && wordsPerSecond <= 3.5) score += 25;
  else if (wordsPerSecond >= 1.5 && wordsPerSecond < 2) score += 10;
  else if (wordsPerSecond > 3.5 && wordsPerSecond <= 4.5) score += 10;

  if (speakerTurns <= 1) score += 15;
  else if (turnsPerMinute >= 4 && turnsPerMinute <= 12) score += 25;
  else if (turnsPerMinute >= 2 && turnsPerMinute < 4) score += 10;
  else if (turnsPerMinute > 12 && turnsPerMinute <= 20) score += 10;

  return Math.min(100, Math.max(1, score));
}

export function computeViralityScore(subScores: {
  hookStrength: number;
  emotionalIntensity: number;
  storyCompleteness?: number;
  pacing: number;
  durationOptimality: number;
}): number {
  return Math.round(
    subScores.hookStrength * 0.3 +
      subScores.emotionalIntensity * 0.22 +
      (subScores.storyCompleteness ?? 50) * 0.18 +
      subScores.pacing * 0.15 +
      subScores.durationOptimality * 0.15,
  );
}

export function computePlatformScore(
  compositeScore: number,
  durationSec: number,
  platform: "tiktok" | "youtube" | "instagram",
): number {
  const idealRanges = {
    tiktok: [15, 60],
    youtube: [30, 90],
    instagram: [15, 45],
  } as const;
  const [minIdeal, maxIdeal] = idealRanges[platform];
  const modifier =
    durationSec >= minIdeal && durationSec <= maxIdeal
      ? 10
      : durationSec < minIdeal
        ? -Math.round(((minIdeal - durationSec) / minIdeal) * 20)
        : -Math.round(((durationSec - maxIdeal) / maxIdeal) * 20);

  return Math.min(100, Math.max(1, compositeScore + modifier));
}
