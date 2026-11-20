import { expect, test } from "bun:test";
import { CLIP_PREPARATION_MAX_UNCHARGED_ATTEMPTS, clipPreparationRetryDelayMs, clipPreparationUnchargedAttempts } from "./clip-preparation";

test("pre-start failures exhaust their own budget instead of retrying until the deadline", () => {
  // generation g fails before start: chargedAttempts stays 0, generation advances once per retry.
  const delays: number[] = [];
  let generation = 1;
  while (clipPreparationUnchargedAttempts({ generation, chargedAttempts: 0 }) < CLIP_PREPARATION_MAX_UNCHARGED_ATTEMPTS) {
    delays.push(clipPreparationRetryDelayMs({ generation, chargedAttempts: 0 }));
    generation += 1;
  }
  expect(generation).toBe(CLIP_PREPARATION_MAX_UNCHARGED_ATTEMPTS);
  expect(delays).toEqual([5_000, 10_000, 20_000, 40_000]);
});

test("charged retries keep their existing backoff", () => {
  expect(clipPreparationRetryDelayMs({ generation: 1, chargedAttempts: 1 })).toBe(10_000);
  expect(clipPreparationRetryDelayMs({ generation: 2, chargedAttempts: 2 })).toBe(20_000);
  expect(clipPreparationUnchargedAttempts({ generation: 3, chargedAttempts: 2 })).toBe(1);
});
