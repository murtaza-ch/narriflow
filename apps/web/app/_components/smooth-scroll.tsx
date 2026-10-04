"use client";

import { useEffect, type ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger);
}

let active: Lenis | null = null;

/** Glide to a scroll offset — through Lenis when it is running. */
export function scrollToY(y: number) {
  if (active) active.scrollTo(y, { duration: 1.1 });
  else window.scrollTo({ top: y });
}

/**
 * Lenis smooth scrolling driven by the GSAP ticker, with ScrollTrigger kept
 * in sync. Skips itself entirely when the user prefers reduced motion.
 */
export function SmoothScroll({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const lenis = new Lenis({ lerp: 0.115, smoothWheel: true });
    lenis.on("scroll", ScrollTrigger.update);
    active = lenis;

    const raf = (time: number) => {
      lenis.raf(time * 1000);
    };
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(raf);
      lenis.destroy();
      active = null;
    };
  }, []);

  return <>{children}</>;
}
