"use client";

import { type ReactNode, useEffect, useRef } from "react";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { gsap, MOTION_QUERIES, ScrollTrigger, setLenis } from "./motion";

/**
 * Page-level motion: Lenis smooth scrolling on the GSAP ticker and the
 * `data-reveal` observer. Content stays visible without JavaScript: reveals
 * only arm once this component sets `data-motion` on the root.
 */
export function LandingShell({ className, children }: { className: string; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduce = window.matchMedia(MOTION_QUERIES.reduce).matches;
    root.dataset.motion = reduce ? "reduced" : "on";

    let lenis: Lenis | null = null;
    const tick = (time: number) => lenis?.raf(time * 1000);
    if (!reduce) {
      lenis = new Lenis({
        lerp: 0.09,
        // Dialogs (the auth modal) and anything marked scroll their own content.
        prevent: (node) => Boolean(node.closest?.("[role='dialog'], [data-lenis-prevent]")),
      });
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);
      setLenis(lenis);
      if (process.env.NODE_ENV !== "production") (window as unknown as { __lenis?: Lenis }).__lenis = lenis;
    }

    // Lenis scrolls the window itself, past `overflow: hidden`. Pause it while a
    // dialog (the auth modal) holds Zag's body scroll lock.
    const syncLock = () => {
      if (document.body.hasAttribute("data-scroll-lock")) lenis?.stop();
      else lenis?.start();
    };
    const lockObserver = new MutationObserver(syncLock);
    if (lenis) {
      lockObserver.observe(document.body, { attributes: true, attributeFilter: ["data-scroll-lock"] });
      syncLock();
    }

    const reveals = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          reveals.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    for (const node of root.querySelectorAll("[data-reveal]")) reveals.observe(node);

    const refresh = () => ScrollTrigger.refresh();
    document.fonts?.ready.then(refresh);
    window.addEventListener("load", refresh);

    return () => {
      lockObserver.disconnect();
      reveals.disconnect();
      window.removeEventListener("load", refresh);
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33);
      lenis?.destroy();
      setLenis(null);
    };
  }, []);

  return (
    <div ref={rootRef} className={className}>
      {children}
    </div>
  );
}
