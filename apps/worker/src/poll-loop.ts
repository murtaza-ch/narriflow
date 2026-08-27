export interface PollLoop {
  name: string;
  tick: () => Promise<void>;
  status: () => { polling: boolean; lastPollAt: string | null };
}

export function createIsolatedPollLoop(input: {
  name: string;
  run: () => Promise<number>;
  maximumConsecutiveFailures: number;
  now?: () => Date;
  onProcessed?: (count: number) => void;
  onFailure?: (error: unknown, consecutiveFailures: number) => void;
  onFailureLimit?: (consecutiveFailures: number) => void;
}): PollLoop {
  let polling = false;
  let lastPollAt: string | null = null;
  let consecutiveFailures = 0;

  return {
    name: input.name,
    status: () => ({ polling, lastPollAt }),
    tick: async () => {
      if (polling) return;
      polling = true;
      lastPollAt = (input.now?.() ?? new Date()).toISOString();
      try {
        const processed = await input.run();
        consecutiveFailures = 0;
        if (processed > 0) input.onProcessed?.(processed);
      } catch (error) {
        consecutiveFailures += 1;
        input.onFailure?.(error, consecutiveFailures);
        if (consecutiveFailures >= input.maximumConsecutiveFailures) {
          input.onFailureLimit?.(consecutiveFailures);
        }
      } finally {
        polling = false;
      }
    },
  };
}
