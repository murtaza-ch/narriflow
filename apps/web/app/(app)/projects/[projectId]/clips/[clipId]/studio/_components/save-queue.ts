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
