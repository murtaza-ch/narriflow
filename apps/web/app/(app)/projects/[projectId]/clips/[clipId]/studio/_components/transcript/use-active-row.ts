"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { PlaybackClock } from "../playback-clock";

/**
 * The row under the playhead: the last row starting at or before `sec`, while `sec` is before its
 * end plus `holdSec` (a short gap between captions keeps the row lit, so the highlight does not
 * blink between them); -1 otherwise. Rows are in time order. Binary search: O(log n) a clock tick.
 */
export function activeRowAt(rows: readonly { readonly startSec: number; readonly endSec: number }[], sec: number, holdSec = 0): number {
  let low = 0;
  let high = rows.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle]!.startSec <= sec) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found >= 0 && sec < rows[found]!.endSec + holdSec ? found : -1;
}

/** The active row's index; React state changes only when the active row does, never per frame. */
export function useActiveRow(clock: PlaybackClock, rows: readonly { readonly startSec: number; readonly endSec: number }[], holdSec = 0): number {
  const [active, setActive] = useState(() => activeRowAt(rows, clock.getSnapshot(), holdSec));
  useEffect(() => {
    const update = () => setActive(activeRowAt(rows, clock.getSnapshot(), holdSec));
    update();
    return clock.subscribe(update);
  }, [clock, rows, holdSec]);
  return active;
}

/** After the owner scrolls the list, the playhead leaves it alone this long. */
const MANUAL_SCROLL_HOLD_MS = 3000;

/**
 * Keeps the active row (by its `data-row-key`) in view when it changes, unless the owner scrolled the list in the last 3 s
 * or is typing in it. Only wheel, touch and keys count as the owner scrolling: the list's own
 * `scrollIntoView` fires scroll events too.
 */
export function useFollowActiveRow(scrollRef: RefObject<HTMLElement | null>, active: string | null): void {
  const manualAt = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const mark = () => {
      manualAt.current = performance.now();
    };
    const onKey = (event: KeyboardEvent) => {
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key)) mark();
    };
    container.addEventListener("wheel", mark, { passive: true });
    container.addEventListener("touchmove", mark, { passive: true });
    container.addEventListener("keydown", onKey);
    return () => {
      container.removeEventListener("wheel", mark);
      container.removeEventListener("touchmove", mark);
      container.removeEventListener("keydown", onKey);
    };
  }, [scrollRef]);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || active === null) return;
    if (performance.now() - manualAt.current < MANUAL_SCROLL_HOLD_MS) return;
    const focused = document.activeElement;
    if (focused && container.contains(focused) && (focused.tagName === "TEXTAREA" || focused.tagName === "INPUT")) return;
    const row = container.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(active)}"]`);
    if (!row) return;
    const box = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < box.top + 16 || rect.bottom > box.bottom - 16) row.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [scrollRef, active]);
}
