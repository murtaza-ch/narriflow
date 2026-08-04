/**
 * Single-flight save scheduling (vizard-parity.md Phase A step 4): the
 * revision-aware autosave PUT must never overlap itself — if an edit lands
 * while a save is in flight, that edit has to trigger exactly one more save
 * after the current one finishes, not a second concurrent request. This is
 * the pure state-transition table for that rule, factored out of
 * studio-shell.tsx so it's unit-testable without a real fetch or timers.
 *
 * Usage: call `requestSave` whenever new work should be persisted (debounce
 * fired, or an explicit flush). If `shouldStartSave` is true, actually start
 * the network call and, in its `finally`, call `completeSave` — if THAT
 * says `shouldStartSave`, immediately start another save (edits arrived
 * mid-flight) rather than waiting for the next debounce.
 */
export type SaveQueueState = "idle" | "saving" | "saving-dirty";

export interface SaveQueueTransition {
  state: SaveQueueState;
  /** True when the caller should (re)start the actual save network call. */
  shouldStartSave: boolean;
}

export function requestSave(current: SaveQueueState): SaveQueueTransition {
  switch (current) {
    case "idle":
      return { state: "saving", shouldStartSave: true };
    case "saving":
      return { state: "saving-dirty", shouldStartSave: false };
    case "saving-dirty":
      return { state: "saving-dirty", shouldStartSave: false };
  }
}

export function completeSave(current: SaveQueueState): SaveQueueTransition {
  switch (current) {
    case "saving":
      return { state: "idle", shouldStartSave: false };
    case "saving-dirty":
      // Edits arrived while the just-finished save was in flight — go
      // straight into another one instead of waiting for the next trigger.
      return { state: "saving", shouldStartSave: true };
    case "idle":
      // Defensive: completeSave shouldn't be called from idle, but treat it
      // as a no-op rather than throwing.
      return { state: "idle", shouldStartSave: false };
  }
}

/**
 * Fix: "Export flush swallows failures" — performSave used to catch every
 * failure mode and resolve anyway, so handleExport/handleSave had no way to
 * know a save actually failed. Callers now thread a per-attempt outcome
 * through the single-flight chain; when a save that went dirty mid-flight
 * triggers an immediate follow-up (see `completeSave` above), the chain's
 * overall result is the combination of every attempt in it. Deliberately
 * conservative: any failure anywhere in the chain marks the whole flush as
 * untrustworthy, even if a later attempt in the same chain went on to
 * succeed — telling those two cases apart would mean plumbing "which attempt
 * corresponds to the document that's live right now" through the queue,
 * which it doesn't track. Callers that need to know "is the CURRENT document
 * actually persisted" (handleExport) pair this with a direct dirty check
 * rather than relying on the outcome alone.
 */
export type SaveOutcome = "success" | "failure";

export function combineSaveOutcomes(
  first: SaveOutcome,
  second: SaveOutcome,
): SaveOutcome {
  return first === "failure" || second === "failure" ? "failure" : "success";
}
