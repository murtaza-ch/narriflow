"use client";

import { type CSSProperties, useRef } from "react";
import { StartLink } from "./actions";
import { MOMENTS } from "./landing-data";
import { gsap, useScene } from "./motion";

/** Ranked moments as a stack of cards in perspective. */
export function Rank() {
  const ref = useRef<HTMLElement>(null);

  useScene(ref, ({ motion }) => {
    if (!motion) return;
    gsap.fromTo(
      ".lx-rank__card",
      { y: 90, opacity: 0 },
      {
        y: 0,
        opacity: 1,
        ease: "power2.out",
        stagger: 0.12,
        scrollTrigger: { trigger: ".lx-rank__stack", start: "top 85%", end: "center 55%", scrub: 0.6 },
      },
    );
  });

  return (
    <section ref={ref} className="lx-rank lx-container" aria-labelledby="rank-title">
      <div className="lx-rank__copy" data-reveal="">
        <h2 id="rank-title" className="lx-serif lx-h2">
          Know what
          <br />
          to post first.
        </h2>
        <p className="lx-lede">
          Every clip gets a virality score, so the strongest moments go out before the rest. Open any of them in the
          editor to trim, extend or reframe.
        </p>
        <StartLink className="lx-mono-btn">Find your best moments</StartLink>
      </div>
      <div className="lx-rank__stage" aria-hidden="true">
        <ol className="lx-rank__stack">
          {MOMENTS.map((moment, i) => (
            <li key={moment.quote} className="lx-rank__card" style={{ "--i": i } as CSSProperties}>
              <img src={moment.src} alt="" loading="lazy" style={{ objectPosition: moment.position }} />
              <div>
                <b>{moment.quote}</b>
                <span>Episode 112 · {moment.time}</span>
              </div>
              <strong>{moment.score}</strong>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
