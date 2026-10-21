"use client";

import { type CSSProperties, type RefObject, useEffect, useMemo, useRef } from "react";
import type { CaptionStyle } from "./caption-styles";
import { ClipCard, styleFor } from "./clip-card";
import { DEMOS, type PlatformId } from "./landing-data";
import { gsap, MOTION_QUERIES, useScene } from "./motion";
import { PlatformIcon } from "./platform-icon";

/*
 * The product story as one pinned, scroll-scrubbed scene: a wide episode is
 * watched, its best moments are found on the timeline, and each one is cut
 * out of the frame as a vertical slice that lands as a captioned clip, ready
 * to post. The link field stays docked at the bottom as the input throughout.
 */

const DEMO = DEMOS[0]!;

/** One line per beat, shown above the stage while that beat plays. */
const LINES = [
  "Paste a link to any long video.",
  "Narriflow finds the moments worth posting.",
  "It reframes each one around the speaker.",
  "Then captions every word.",
  "And schedules them everywhere.",
];

/** Timeline span of each beat, in scene time. */
const BEATS: [number, number][] = [
  [0, 2],
  [2, 4.2],
  [4.2, 6.2],
  [6.2, 8.2],
  [8.2, 10],
];

/** Per cut: where the speaker sits across the wide frame, the slot its clip lands in, and where it posts. */
const CUTS: { focus: number; slot: "left" | "center" | "right"; platforms: [PlatformId, PlatformId]; when: string }[] = [
  { focus: 0.21, slot: "center", platforms: ["tiktok", "youtube"], when: "Tue 9:00" },
  { focus: 0.79, slot: "right", platforms: ["instagram", "linkedin"], when: "Wed 12:30" },
  { focus: 0.21, slot: "left", platforms: ["x", "facebook"], when: "Thu 18:00" },
];

const BARS = 140;

/** "1:02:03" or "4:05" to seconds. */
function seconds(time: string) {
  return time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

/** A speech-like waveform: noise shaped into phrases, smoothed. */
function waveform() {
  const raw = Array.from({ length: BARS }, (_, i) => {
    const noise = Math.abs(Math.sin((i + 1) * 12.9898) * 43758.5453) % 1;
    const phrase = 0.5 + 0.5 * Math.abs(Math.sin(i / 6.1));
    return 0.12 + 0.88 * noise * phrase;
  });
  return raw.map((value, i) => ((raw[i - 1] ?? value) + value * 2 + (raw[i + 1] ?? value)) / 4);
}

/** Layout box of `node` inside `root`, ignoring transforms. */
function boxIn(node: HTMLElement, root: HTMLElement) {
  let x = 0;
  let y = 0;
  let current: HTMLElement | null = node;
  while (current && current !== root) {
    x += current.offsetLeft;
    y += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return { x, y, w: node.offsetWidth, h: node.offsetHeight };
}

/** Tilts the stage a few degrees toward the pointer. */
function useTilt(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const node = ref.current;
    const stage = node?.parentElement;
    if (!node || !stage) return;
    if (!window.matchMedia(`${MOTION_QUERIES.motion} and (hover: hover)`).matches) return;
    let frame = 0;
    const target = { x: 0, y: 0 };
    const now = { x: 0, y: 0 };
    const step = () => {
      now.x += (target.x - now.x) * 0.08;
      now.y += (target.y - now.y) * 0.08;
      node.style.setProperty("--rx", `${(-now.y * 3).toFixed(3)}deg`);
      node.style.setProperty("--ry", `${(now.x * 4).toFixed(3)}deg`);
      frame = Math.abs(target.x - now.x) + Math.abs(target.y - now.y) > 0.001 ? requestAnimationFrame(step) : 0;
    };
    const move = (event: PointerEvent) => {
      const box = stage.getBoundingClientRect();
      target.x = ((event.clientX - box.left) / box.width) * 2 - 1;
      target.y = ((event.clientY - box.top) / box.height) * 2 - 1;
      if (!frame) frame = requestAnimationFrame(step);
    };
    const leave = () => {
      target.x = 0;
      target.y = 0;
      if (!frame) frame = requestAnimationFrame(step);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerleave", leave);
    };
  }, [ref]);
}

export function Scene({ styles }: { styles: Record<string, CaptionStyle> }) {
  const ref = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const bars = useMemo(waveform, []);
  const length = seconds(DEMO.length);
  const marks = DEMO.cuts.map((cut) => (seconds(cut.at) + seconds(cut.duration) / 2) / length);
  useTilt(canvasRef);

  useScene(ref, ({ motion }, root) => {
    if (!motion) return;
    const all = <T extends HTMLElement>(selector: string) => [...root.querySelectorAll<T>(selector)];
    const canvas = canvasRef.current;
    const base = root.querySelector<HTMLElement>(".lx-scene__base");
    const timeline = root.querySelector<HTMLElement>(".lx-scene__timeline");
    const chip = root.querySelector<HTMLElement>(".lx-scene__chip");
    if (!canvas || !base || !timeline || !chip) return;
    const [watching, found] = all<HTMLElement>(".lx-scene__chip > span");
    const slices = all<HTMLElement>(".lx-scene__slice").sort((a, b) => Number(a.dataset.cut) - Number(b.dataset.cut));
    const slots = all<HTMLElement>(".lx-scene__clip");
    const pins = all<HTMLElement>(".lx-scene__pin");
    const posts = all<HTMLElement>(".lx-scene__post");
    const lines = all<HTMLElement>(".lx-scene__lines p");
    const story = all<HTMLElement>(".lx-scene__story i");
    const card = slots[0]?.querySelector<HTMLElement>(".lx-clip");

    const frame = () => boxIn(base, canvas);
    const half = () => {
      const f = frame();
      return (f.h * 9) / 16 / f.w / 2;
    };
    // The crop that leaves only the speaker's 9:16 slice, with the clip's corner radius once scaled up.
    const crop = (i: number) => () => {
      const f = frame();
      const h = half();
      const focus = CUTS[i]!.focus;
      const scale = boxIn(slots[i]!, canvas).h / f.h;
      const radius = (card ? Number.parseFloat(getComputedStyle(card).borderTopLeftRadius) : 22) / scale;
      return `inset(0% ${((1 - focus - h) * 100).toFixed(3)}% 0% ${((focus - h) * 100).toFixed(3)}% round ${radius.toFixed(2)}px)`;
    };
    // Moves the slice so it covers its clip's slot exactly.
    const lift = (i: number) => {
      const fit = () => ({ f: frame(), s: boxIn(slots[i]!, canvas) });
      return {
        x: () => {
          const { f, s } = fit();
          return s.x + s.w / 2 - (f.x + CUTS[i]!.focus * f.w);
        },
        y: () => {
          const { f, s } = fit();
          return s.y + s.h / 2 - (f.y + f.h / 2);
        },
        scale: () => {
          const { f, s } = fit();
          return s.h / f.h;
        },
      };
    };

    // Start state. Every value the timeline animates is set here first, so scrubbing back restores it.
    gsap.set([base, ...slices], { opacity: 0, y: 70, scale: 0.94 });
    slices.forEach((slice, i) => {
      gsap.set(slice, {
        transformOrigin: `${CUTS[i]!.focus * 100}% 50%`,
        clipPath: "inset(0% 0% 0% 0% round 16px)",
        filter: "brightness(1)",
      });
    });
    gsap.set([chip, timeline], { opacity: 0, y: 14 });
    gsap.set(found ?? [], { opacity: 0 });
    // How much of the episode the playhead has watched, as --p on the timeline.
    const watched = { p: 0 };
    const paintWatched = () => timeline.style.setProperty("--p", watched.p.toFixed(4));
    paintWatched();
    gsap.set(pins, { opacity: 0, scale: 0.6, y: 6 });
    gsap.set(slots, { opacity: 0 });
    gsap.set(posts, { opacity: 0, y: 18, scale: 0.85 });
    gsap.set(lines, { opacity: 0, yPercent: 60 });
    gsap.set(story, { scaleX: 0 });

    const tl = gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: {
        trigger: root,
        start: "top 70%",
        end: "bottom bottom",
        scrub: 0.7,
        invalidateOnRefresh: true,
      },
    });

    BEATS.forEach(([from, to], i) => {
      tl.to(story[i] ?? [], { scaleX: 1, duration: to - from }, from);
      const line = lines[i];
      if (!line) return;
      tl.to(line, { opacity: 1, yPercent: 0, duration: 0.45, ease: "power2.out" }, from);
      if (i < lines.length - 1) tl.to(line, { opacity: 0, yPercent: -60, duration: 0.45, ease: "power2.in" }, to - 0.45);
    });

    // 1. The episode rises into view.
    tl.to([base, ...slices], { opacity: 1, y: 0, scale: 1, duration: 1.1, ease: "power3.out" }, 0);
    tl.to(chip, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, 0.8);
    // After the stage has pinned (about 1.8), so the waveform never passes behind the field.
    tl.to(timeline, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, 1.8);

    // 2. The playhead watches it through; each moment pops as it passes.
    tl.to(watched, { p: 1, duration: 1.8, onUpdate: paintWatched }, 2.2);
    pins.forEach((pin, i) => {
      tl.to(pin, { opacity: 1, scale: 1, y: 0, duration: 0.35, ease: "back.out(2.2)" }, 2.2 + 1.8 * (marks[i] ?? 0));
    });
    if (watching && found) {
      tl.to(watching, { opacity: 0, duration: 0.2 }, 3.9);
      tl.to(found, { opacity: 1, duration: 0.2 }, 4);
    }

    // 3. The first moment is cut out of the frame and lifted into a vertical clip.
    tl.to([timeline, chip], { opacity: 0, y: 14, duration: 0.4, ease: "power2.in" }, 4.2);
    tl.to(slices.slice(1), { filter: "brightness(0.4)", duration: 0.5 }, 4.3);
    tl.to(slices[0]!, { clipPath: crop(0), duration: 0.7, ease: "power2.inOut" }, 4.3);
    tl.to(slices[0]!, { ...lift(0), duration: 0.95, ease: "power3.inOut" }, 4.9);
    tl.to(slots[0]!, { opacity: 1, duration: 0.3 }, 5.65);
    tl.set(slices[0]!, { opacity: 0 }, 5.95);

    // 4. The other two tear out and land beside it.
    [1, 2].forEach((i, k) => {
      const at = 6.3 + k * 0.3;
      tl.to(slices[i]!, { clipPath: crop(i), filter: "brightness(1)", duration: 0.6, ease: "power2.inOut" }, at);
      tl.to(slices[i]!, { ...lift(i), duration: 0.95, ease: "power3.inOut" }, at + 0.5);
      tl.to(slots[i]!, { opacity: 1, duration: 0.3 }, at + 1.25);
      tl.set(slices[i]!, { opacity: 0 }, at + 1.55);
    });
    tl.to(base, { opacity: 0, scale: 0.97, duration: 0.6 }, 7);

    // 5. Each clip gets its platforms and a slot in the schedule.
    posts.forEach((post, i) => {
      tl.to(post, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(1.8)" }, 8.4 + i * 0.22);
    });
    tl.to({}, { duration: 0.4 }, 9.6);
  });

  return (
    <section ref={ref} className="lx-scene" id="product" aria-labelledby="scene-title">
      <div className="lx-scene__stage">
        <div className="lx-scene__head">
          <ol className="lx-scene__story" aria-hidden="true">
            {LINES.map((line) => (
              <li key={line}>
                <i />
              </li>
            ))}
          </ol>
          <h2 id="scene-title" className="lx-sr">
            From one link to captioned clips on every platform
          </h2>
          <div className="lx-scene__lines">
            {LINES.map((line) => (
              <p key={line} className="lx-serif">
                {line}
              </p>
            ))}
          </div>
        </div>

        <div className="lx-scene__canvas" ref={canvasRef}>
          <div className="lx-scene__base" aria-hidden="true">
            <img src={DEMO.src} alt="" decoding="async" style={{ objectPosition: DEMO.position }} />
          </div>
          {[2, 1, 0].map((i) => (
            <div key={i} className="lx-scene__slice" data-cut={i} aria-hidden="true">
              <img src={DEMO.src} alt="" decoding="async" style={{ objectPosition: DEMO.position }} />
            </div>
          ))}

          <p className="lx-scene__chip">
            <span>
              <i aria-hidden="true" />
              Watching <em>{DEMO.title} · </em>
              {DEMO.length}
            </span>
            <span>
              <i aria-hidden="true" />
              {DEMO.cuts.length} moments found
            </span>
          </p>

          <div className="lx-scene__timeline" aria-hidden="true">
            <div className="lx-scene__wave">
              {bars.map((height, b) => {
                const t = b / (BARS - 1);
                const hit = marks.some((mark) => Math.abs(mark - t) < 0.012);
                return (
                  <i
                    key={b}
                    className={hit ? "is-hit" : undefined}
                    style={{ "--h": height.toFixed(3), "--t": t.toFixed(3) } as CSSProperties}
                  />
                );
              })}
            </div>
            <span className="lx-scene__playhead" />
            {DEMO.cuts.map((cut, i) => (
              <span key={cut.src} className="lx-scene__pin" style={{ "--x": marks[i] } as CSSProperties}>
                <b>{cut.score}</b>
                <span>{cut.title}</span>
              </span>
            ))}
          </div>

          <ol className="lx-scene__clips">
            {DEMO.cuts.map((cut, i) => {
              const plan = CUTS[i]!;
              return (
                <li key={cut.src} className="lx-scene__clip" data-slot={plan.slot}>
                  <ClipCard
                    src={cut.src}
                    alt=""
                    score={cut.score}
                    duration={cut.duration}
                    caption={cut.caption}
                    style={styleFor(styles, cut.presetId)}
                  />
                  <p className="lx-scene__post">
                    {plan.platforms.map((id) => (
                      <PlatformIcon key={id} id={id} />
                    ))}
                    <span>{plan.when}</span>
                  </p>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
