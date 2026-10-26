"use client";

import { useEffect, useRef } from "react";
import { LinkForm } from "./actions";
import type { CaptionStyle } from "./caption-styles";
import { CLIPS, PLATFORMS, SOURCE_WORDS } from "./landing-data";
import { PlatformIcon } from "./platform-icon";
import { Scene } from "./scene";
import { Tunnel } from "./tunnel";

const GLYPHS = "▚▞▙▟▛▜#%&@*+=?";
const WORD_MS = 2600;

/** A headline word that scrambles into the next one. */
function Scramble({ words }: { words: string[] }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let index = 0;
    let raf = 0;
    const swap = () => {
      const from = words[index] ?? "";
      index = (index + 1) % words.length;
      const to = words[index] ?? "";
      const length = Math.max(from.length, to.length);
      const start = performance.now();
      const tick = (now: number) => {
        const t = (now - start) / 640;
        let text = "";
        for (let i = 0; i < length; i++) {
          // Each letter settles a little after the one before it.
          const settle = 0.25 + (i / length) * 0.75;
          if (t >= settle) text += to[i] ?? "";
          else if (i < Math.max(to.length, from.length * (1 - t))) text += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        }
        node.textContent = text;
        if (t < 1) raf = requestAnimationFrame(tick);
        else node.textContent = to;
      };
      raf = requestAnimationFrame(tick);
    };
    const id = window.setInterval(swap, WORD_MS);
    return () => {
      window.clearInterval(id);
      cancelAnimationFrame(raf);
    };
  }, [words]);

  return (
    <span className="lx-scramble" aria-hidden="true">
      <span ref={ref}>{words[0]}</span>
    </span>
  );
}

/**
 * Hero and product scene. The link field is a single sticky element: it waits
 * in the hero's slot, then stays docked at the bottom of the screen as the
 * input while the scene above it plays, and leaves with the scene.
 */
export function Intro({ styles, freeCredits }: { styles: Record<string, CaptionStyle>; freeCredits: number }) {
  return (
    <div className="lx-intro">
      <section className="lx-hero" id="top" aria-labelledby="hero-title">
        <div className="lx-hero__head lx-container">
          <h1 id="hero-title" className="lx-serif lx-hero__title">
            <span className="lx-sr">Turn any long video into a week of shorts</span>
            <span aria-hidden="true">
              Turn any <Scramble words={SOURCE_WORDS} />
              <br />
              into a week of shorts
            </span>
          </h1>
        </div>
        <Tunnel clips={CLIPS} styles={styles} />
        <p className="lx-hero__sub lx-container">
          Narriflow finds the moments worth posting in your long videos, frames them vertical, captions every word and
          schedules them to six platforms.
        </p>
        <div className="lx-hero__foot lx-container">
          <div className="lx-hero__slot" aria-hidden="true" />
          <p className="lx-hero__note">Free plan · {freeCredits} credits a month</p>
          <div className="lx-hero__publish">
            <span>Publishes to</span>
            <ul>
              {PLATFORMS.map((platform) => (
                <li key={platform.id} title={platform.name}>
                  <PlatformIcon id={platform.id} />
                  <span className="lx-sr">{platform.name}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <Scene styles={styles} />

      <div className="lx-rail">
        <div className="lx-travel">
          <LinkForm placeholder="Paste a podcast link" />
        </div>
      </div>
    </div>
  );
}
