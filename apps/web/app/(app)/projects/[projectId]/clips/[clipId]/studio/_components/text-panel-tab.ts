"use client";

import { useSyncExternalStore } from "react";

/**
 * The Text panel's tab. Opening Settings is part of selecting a layer (from the canvas, a chip, a
 * row or a button), so selecting the layer that is already selected still shows its Settings. A
 * module store, not panel state: the panel mounts on demand, and the timeline and canvas set it.
 */
export type TextPanelTab = "presets" | "settings";

let current: TextPanelTab = "presets";
const listeners = new Set<() => void>();

export function showTextPanelTab(tab: TextPanelTab) {
  if (current === tab) return;
  current = tab;
  for (const listener of listeners) listener();
}

/** The tab now, outside React. */
export function currentTextPanelTab(): TextPanelTab {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTextPanelTab(): TextPanelTab {
  // The panel renders only in the browser (the Studio loads it on demand), so both snapshots read the store.
  return useSyncExternalStore(subscribe, currentTextPanelTab, currentTextPanelTab);
}
