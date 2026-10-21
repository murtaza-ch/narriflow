"use client";

import { type RefObject, useEffect, useLayoutEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type Lenis from "lenis";

if (typeof window !== "undefined") gsap.registerPlugin(ScrollTrigger);

export { gsap, ScrollTrigger };

export const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Media queries every scene is built against. */
export const MOTION_QUERIES = {
  motion: "(prefers-reduced-motion: no-preference)",
  reduce: "(prefers-reduced-motion: reduce)",
  wide: "(min-width: 960px)",
} as const;

export type MotionConditions = Record<keyof typeof MOTION_QUERIES, boolean>;

/**
 * Builds a GSAP scene scoped to `scope`. Selector strings inside `build`
 * resolve within the scope, and everything (tweens, ScrollTriggers) is
 * reverted when the media conditions change or the component unmounts.
 */
export function useScene(
  scope: RefObject<HTMLElement | null>,
  build: (conditions: MotionConditions, root: HTMLElement) => unknown,
) {
  // Built once per mount; matchMedia rebuilds the scene when a breakpoint changes.
  useIsoLayoutEffect(() => {
    const root = scope.current;
    if (!root) return;
    const mm = gsap.matchMedia();
    mm.add(
      MOTION_QUERIES,
      (context) => {
        const cleanup = build(context.conditions as MotionConditions, root);
        return typeof cleanup === "function" ? (cleanup as () => void) : undefined;
      },
      root,
    );
    return () => mm.revert();
  }, []);
}

let activeLenis: Lenis | null = null;

export function setLenis(instance: Lenis | null) {
  activeLenis = instance;
}

/** Smooth-scrolls to an element selector or a pixel offset. */
export function scrollToTarget(target: string | number) {
  if (activeLenis) {
    activeLenis.scrollTo(target, { duration: 1.4 });
    return;
  }
  if (typeof target === "number") {
    window.scrollTo({ top: target, behavior: "smooth" });
    return;
  }
  document.querySelector(target)?.scrollIntoView({ behavior: "smooth" });
}
