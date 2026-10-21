"use client";

import { useRef } from "react";
import { StartLink } from "./actions";
import type { CaptionStyle } from "./caption-styles";
import { ClipCard, styleFor } from "./clip-card";
import { CLIPS } from "./landing-data";
import { gsap, useScene } from "./motion";

const COLUMNS = 9;
const PER_COLUMN = 3;

/** A wall of finished clips laid on a tilted plane; columns drift at different speeds. */
export function ClipWall({ styles }: { styles: Record<string, CaptionStyle> }) {
  const ref = useRef<HTMLElement>(null);

  useScene(ref, ({ motion }, root) => {
    if (!motion) return;
    const trigger = { trigger: root, start: "top bottom", end: "bottom top", scrub: true };
    gsap.utils.toArray<HTMLElement>(".lx-wall__col", root).forEach((column, i) => {
      gsap.fromTo(
        column,
        { yPercent: i % 2 ? -14 : 6 },
        { yPercent: i % 2 ? 6 : -14, ease: "none", scrollTrigger: trigger },
      );
    });
    gsap.fromTo(".lx-wall__plane", { rotateX: 46 }, { rotateX: 30, ease: "none", scrollTrigger: trigger });
  });

  const columns = Array.from({ length: COLUMNS }, (_, c) =>
    Array.from({ length: PER_COLUMN }, (_, r) => CLIPS[(c * 3 + r * 5) % CLIPS.length]!),
  );

  return (
    <section ref={ref} className="lx-wall" aria-labelledby="wall-title">
      <div className="lx-wall__head lx-container" data-reveal="">
        <h2 id="wall-title" className="lx-serif lx-h2">
          Clips worth posting,
          <br />
          <span className="lx-dim">from every kind of long video.</span>
        </h2>
        <StartLink className="lx-mono-btn">Try it free</StartLink>
      </div>
      <div className="lx-wall__stage" aria-hidden="true">
        <div className="lx-wall__plane">
          {columns.map((column, c) => (
            <div key={c} className="lx-wall__col">
              {column.map((clip, r) => (
                <ClipCard
                  key={`${clip.id}-${r}`}
                  src={clip.src}
                  alt=""
                  score={clip.score}
                  duration={clip.duration}
                  caption={clip.caption}
                  style={styleFor(styles, clip.presetId)}
                  live={false}
                  imageStyle={clip.position ? { objectPosition: clip.position } : undefined}
                  className="lx-wall__card"
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
