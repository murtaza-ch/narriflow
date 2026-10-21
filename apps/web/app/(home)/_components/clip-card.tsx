"use client";

import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { CaptionStyle } from "./caption-styles";

const WORD_MS = 330;

/** The style for `id`, falling back to Bold Pop (the catalog default, always passed in). */
export function styleFor(styles: Record<string, CaptionStyle>, id: string): CaptionStyle {
  return (styles[id] ?? styles["bold-pop"]) as CaptionStyle;
}

function shadowCss(style: CaptionStyle) {
  const layers: string[] = [];
  if (style.shadow === "soft") layers.push(`0 0.05em 0.28em ${style.shadowColor}99`);
  if (style.shadow === "hard") layers.push(`0 0.07em 0 ${style.shadowColor}`);
  if (style.shadow === "extrude") {
    layers.push(
      `0.03em 0.03em 0 ${style.shadowColor}`,
      `0.06em 0.06em 0 ${style.shadowColor}`,
      `0.09em 0.09em 0 ${style.shadowColor}`,
    );
  }
  if (style.glow) layers.push(`0 0 0.3em ${style.glow}`, `0 0 0.7em ${style.glow}`);
  return layers.length ? layers.join(", ") : "none";
}

/** Fires `onChange` when the element enters or leaves the viewport. */
function useVisible<T extends Element>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { rootMargin: "80px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, visible] as const;
}

/**
 * Word-by-word caption in a real preset's look. Cues hold `wordsPerCue`
 * words, the same grouping the export uses; the active word takes the
 * highlight colour, box or glow. Sized in canvas px against a 1080-wide
 * frame through container query units, so it scales with its card.
 */
export function Caption({ text, style, playing = true }: { text: string; style: CaptionStyle; playing?: boolean }) {
  const words = useMemo(() => text.trim().split(/\s+/).filter(Boolean), [text]);
  const [ref, visible] = useVisible<HTMLDivElement>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!playing || !visible) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setTick((value) => value + 1), WORD_MS);
    return () => window.clearInterval(id);
  }, [playing, visible]);

  const perCue = Math.max(1, style.wordsPerCue);
  const index = words.length ? tick % words.length : 0;
  const cueStart = Math.floor(index / perCue) * perCue;
  const cue = words.slice(cueStart, cueStart + perCue);
  const active = index - cueStart;

  const vars = {
    "--cap-font": `var(${style.fontVar})`,
    "--cap-size": style.size,
    "--cap-tracking": `${style.tracking}em`,
    "--cap-transform": style.transform,
    "--cap-color": style.color,
    "--cap-hl": style.highlight,
    "--cap-outline": style.outlineColor,
    "--cap-stroke": style.outlineWidth,
    "--cap-shadow": shadowCss(style),
    "--cap-box": style.box ?? "transparent",
    "--cap-plate": style.plate ?? "transparent",
    "--cap-hl-glow": style.highlightGlow ?? "transparent",
  } as CSSProperties;

  return (
    <div
      ref={ref}
      className="lx-cap"
      style={vars}
      data-anim={style.animation}
      data-box={style.box ? "" : undefined}
      data-plate={style.plate ? "" : undefined}
      data-glow={style.highlightGlow ? "" : undefined}
      aria-hidden="true"
    >
      <span className="lx-cap__cue" key={`${text}-${cueStart}`}>
        {cue.map((word, i) => (
          <span
            key={`${cueStart}-${i}`}
            className={i === active ? "lx-cap__w is-on" : i < active ? "lx-cap__w is-past" : "lx-cap__w"}
          >
            {word}
          </span>
        ))}
      </span>
    </div>
  );
}

export function ScoreChip({ score }: { score: number }) {
  return (
    <span className="lx-score" title={`Virality score ${score}`}>
      <svg viewBox="0 0 36 36" className="lx-score__ring" aria-hidden="true">
        <circle cx="18" cy="18" r="15" pathLength="100" className="lx-score__track" />
        <circle cx="18" cy="18" r="15" pathLength="100" className="lx-score__fill" strokeDasharray={`${score} 100`} />
      </svg>
      {score}
    </span>
  );
}

export type ClipCardProps = {
  src: string;
  alt: string;
  score: number;
  duration?: string;
  caption: string;
  style: CaptionStyle;
  eager?: boolean;
  /** Animate the caption word by word. Off for large galleries: they show the first cue. */
  live?: boolean;
  className?: string;
  imageStyle?: CSSProperties;
  children?: ReactNode;
};

/** A 9:16 clip: footage, score, runtime, live caption and a playback bar. */
export function ClipCard({
  src,
  alt,
  score,
  duration,
  caption,
  style,
  eager,
  live = true,
  className,
  imageStyle,
  children,
}: ClipCardProps) {
  return (
    <figure className={className ? `lx-clip ${className}` : "lx-clip"}>
      <img
        className="lx-clip__img"
        src={src}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "auto"}
        decoding="async"
        style={imageStyle}
      />
      {children}
      <div className="lx-clip__top">
        <ScoreChip score={score} />
        {duration ? <span className="lx-clip__dur">{duration}</span> : null}
      </div>
      <div className="lx-clip__cap">
        <Caption text={caption} style={style} playing={live} />
      </div>
      <div className="lx-clip__bar">
        <span />
      </div>
    </figure>
  );
}
