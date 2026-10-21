"use client";

import { type CSSProperties, useEffect, useRef } from "react";
import { scrollToTarget } from "./motion";

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function clock(total: number) {
  const s = Math.floor(total % 60);
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const MARK = "Narriflow".split("");
const FILLS = [
  "/landing/story-chef.webp",
  "/landing/moment-livestream-1.webp",
  "/landing/story-trainer.webp",
  "/landing/moment-coaching-1.webp",
  "/landing/story-podcaster.webp",
  "/landing/moment-podcast-3.webp",
  "/landing/story-coach.webp",
  "/landing/moment-livestream-3.webp",
  "/landing/moment-coaching-2.webp",
];
/** The wordmark reads as one episode; the playhead's timecode runs across it. */
const MARK_LENGTH = 72 * 60 + 40;

/**
 * The wordmark with footage inside it. A playhead follows the pointer across
 * it and the letters it passes play their clip; left alone, it sweeps by itself.
 */
export function FootageMark() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || reduced()) return;
    root.dataset.live = "";
    const letters = [...root.querySelectorAll<HTMLElement>(".lx-mark__l")];
    const time = root.querySelector<HTMLElement>(".lx-mark__time");
    const started = performance.now();
    let x = root.clientWidth * 0.1;
    let pointer: number | null = null;
    let lastMove = 0;
    let raf = 0;

    const frame = (now: number) => {
      const width = root.clientWidth;
      if (pointer !== null && now - lastMove > 2400) pointer = null;
      const target = pointer ?? ((Math.sin((now - started) / 2800 - 1.2) + 1) / 2) * width;
      x += (target - x) * 0.12;
      root.style.setProperty("--x", `${x.toFixed(1)}px`);
      // Footage shows through the letters near the playhead and fades with distance.
      for (const letter of letters) {
        const offset = Math.abs(x - (letter.offsetLeft + letter.offsetWidth / 2)) / letter.offsetWidth;
        letter.style.setProperty("--on", Math.min(1, Math.max(0, 1.5 - offset * 1.4)).toFixed(3));
      }
      if (time) {
        time.textContent = clock((x / Math.max(1, width)) * MARK_LENGTH);
        // Keep the timecode chip inside the wordmark at either edge.
        const chip = time.offsetWidth;
        const shift = Math.min(Math.max(-chip / 2, 4 - x), width - x - chip - 4);
        time.style.setProperty("--tx", `${shift.toFixed(1)}px`);
      }
      raf = requestAnimationFrame(frame);
    };

    const move = (event: PointerEvent) => {
      pointer = event.clientX - root.getBoundingClientRect().left;
      lastMove = performance.now();
    };
    const leave = () => {
      pointer = null;
    };
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerleave", leave);

    const observer = new IntersectionObserver(([entry]) => {
      cancelAnimationFrame(raf);
      if (entry?.isIntersecting) raf = requestAnimationFrame(frame);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <div ref={ref} className="lx-mark" aria-hidden="true">
      {MARK.map((letter, i) => (
        <span
          key={i}
          className="lx-mark__l"
          data-l={letter}
          style={{ "--img": `url(${FILLS[i % FILLS.length]})`, "--i": i } as CSSProperties}
        >
          {letter}
        </span>
      ))}
      <span className="lx-mark__head">
        <span className="lx-mark__time">0:00</span>
      </span>
    </div>
  );
}

/** Back to the top, in the page's own terms. */
export function RewindButton() {
  return (
    <button type="button" className="lx-rewind" onClick={() => scrollToTarget(0)}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11 6 4 12l7 6V6Zm9 0-7 6 7 6V6Z" />
      </svg>
      Rewind to 0:00
    </button>
  );
}
