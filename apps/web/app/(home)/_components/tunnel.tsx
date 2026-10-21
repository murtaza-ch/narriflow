"use client";

import { useEffect, useRef } from "react";
import type { CaptionStyle } from "./caption-styles";
import { ClipCard, styleFor } from "./clip-card";
import type { DemoClip } from "./landing-data";

/** How many times the clip list repeats around the ring. */
const LAPS = 3;

/**
 * Clips on the inside of a cylinder, seen from near its centre: the middle
 * cards recede, the edge cards loom. The ring turns slowly; each frame sets
 * one transform per card, and the loop pauses off screen.
 */
export function Tunnel({ clips, styles }: { clips: DemoClip[]; styles: Record<string, CaptionStyle> }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const cards = Array.from(root.querySelectorAll<HTMLElement>(".lx-tunnel__card"));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let offset = 0;
    let last = performance.now();
    let raf = 0;
    let running = false;

    const layout = () => {
      const mobile = root.clientWidth < 760;
      const cardW = mobile ? 122 : 150;
      const step = cardW + (mobile ? 12 : 16);
      const radius = mobile ? 560 : 1080;
      // Pull the camera most of the way into the cylinder so the edges come close.
      const pull = radius * 0.86;
      const perspective = mobile ? 520 : 900;
      const total = cards.length * step;
      cards.forEach((card, i) => {
        const arc = ((((i * step + offset) % total) + total) % total) - total / 2;
        const theta = arc / radius;
        const z = -radius * Math.cos(theta) + pull;
        if (Math.abs(theta) > 1.4 || z > perspective * 0.66) {
          card.style.visibility = "hidden";
          return;
        }
        card.style.visibility = "visible";
        card.style.width = `${cardW}px`;
        card.style.transform = `translate(-50%, -50%) translateZ(${pull}px) rotateY(${theta}rad) translateZ(${-radius}px)`;
      });
    };

    const frame = (now: number) => {
      offset -= (now - last) * 0.028;
      last = now;
      layout();
      if (running) raf = requestAnimationFrame(frame);
    };

    layout();
    root.dataset.ready = "";
    if (reduce) {
      window.addEventListener("resize", layout);
      return () => window.removeEventListener("resize", layout);
    }

    const observer = new IntersectionObserver(([entry]) => {
      running = Boolean(entry?.isIntersecting) && !document.hidden;
      cancelAnimationFrame(raf);
      if (running) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    });
    observer.observe(root);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  const ring = Array.from({ length: LAPS }, () => clips).flat();

  return (
    <div ref={ref} className="lx-tunnel" aria-hidden="true">
      {ring.map((clip, i) => (
        <ClipCard
          key={`${clip.id}-${i}`}
          src={clip.src}
          alt=""
          score={clip.score}
          duration={clip.duration}
          caption={clip.caption}
          style={styleFor(styles, clip.presetId)}
          eager={i < clips.length}
          live={false}
          imageStyle={clip.position ? { objectPosition: clip.position } : undefined}
          className="lx-tunnel__card"
        />
      ))}
    </div>
  );
}
