"use client";

import { type CSSProperties, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { LinkForm } from "./actions";
import type { CaptionStyle } from "./caption-styles";
import { ClipCard, styleFor } from "./clip-card";
import { DEMOS, SOURCE_FRAME } from "./landing-data";

/*
 * Four variants of the closing call to action, for review. Each one is built
 * around a single interaction with the link field as the action. Once one is
 * chosen, the other three and the dial are deleted.
 */

const VARIANTS = [
  { id: "links", label: "Any link" },
  { id: "feed", label: "Feed" },
  { id: "compare", label: "Before / after" },
  { id: "fan", label: "Fan" },
] as const;

type Variant = (typeof VARIANTS)[number]["id"];
type Props = { styles: Record<string, CaptionStyle>; freeCredits: number };

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function useOnScreen<T extends Element>(threshold: number) {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setOn(Boolean(entry?.isIntersecting)), { threshold });
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);
  return [ref, on] as const;
}

function Title({ first, second }: { first: string; second: string }) {
  return (
    <h2 id="end-title" className="lx-serif lx-close__title">
      {first}
      <br />
      <span className="lx-dim">{second}</span>
    </h2>
  );
}

function Note({ freeCredits }: { freeCredits: number }) {
  return <p className="lx-close__note">Free plan · {freeCredits} credits a month</p>;
}

/* ---------- 1. Any link: the field types real links and each one's clips slide out ---------- */

function AnyLink({ styles, freeCredits }: Props) {
  const [ref, onScreen] = useOnScreen<HTMLDivElement>(0.4);
  const [demo, setDemo] = useState(0);
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<"typing" | "shown" | "leaving">("typing");
  const [paused, setPaused] = useState(false);
  const current = DEMOS[demo] ?? DEMOS[0]!;

  useEffect(() => {
    if (!onScreen || paused) return;
    if (reduced()) {
      setTyped(current.link);
      setPhase("shown");
      return;
    }
    let timer = 0;
    if (phase === "typing") {
      timer =
        typed.length < current.link.length
          ? window.setTimeout(() => setTyped(current.link.slice(0, typed.length + 1)), 38)
          : window.setTimeout(() => setPhase("shown"), 350);
    } else if (phase === "shown") {
      timer = window.setTimeout(() => setPhase("leaving"), 3600);
    } else {
      timer = window.setTimeout(() => {
        setDemo((value) => (value + 1) % DEMOS.length);
        setTyped("");
        setPhase("typing");
      }, 450);
    }
    return () => window.clearTimeout(timer);
  }, [onScreen, paused, phase, typed, current.link]);

  return (
    <div ref={ref} className="lx-close lx-close--links">
      <Title first="Paste any link." second="We'll take it from there." />
      <div
        className="lx-links__field"
        data-demo={paused ? undefined : ""}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={() => setPaused(false)}
      >
        <LinkForm placeholder={paused ? "Paste a video link" : typed || " "} />
      </div>
      <ol className="lx-links__clips" data-phase={phase} key={current.id}>
        {current.cuts.map((cut, i) => (
          <li key={cut.src} style={{ "--i": i } as CSSProperties}>
            <ClipCard
              src={cut.src}
              alt=""
              score={cut.score}
              duration={cut.duration}
              caption={cut.caption}
              style={styleFor(styles, cut.presetId)}
            />
          </li>
        ))}
      </ol>
      <Note freeCredits={freeCredits} />
    </div>
  );
}

/* ---------- 2. Feed: a vertical feed of clips that swipes on its own ---------- */

const FEED = DEMOS.flatMap((demo) => demo.cuts);

function Feed({ styles, freeCredits }: Props) {
  const [ref, onScreen] = useOnScreen<HTMLDivElement>(0.4);
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const drag = useRef<number | null>(null);

  useEffect(() => {
    if (!onScreen || held || reduced()) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % FEED.length), 2600);
    return () => window.clearInterval(timer);
  }, [onScreen, held]);

  const go = (step: number) => setIndex((value) => (value + step + FEED.length) % FEED.length);

  return (
    <div ref={ref} className="lx-close lx-close--feed">
      <div className="lx-feed__copy">
        <Title first="Your feed," second="already cut." />
        <LinkForm />
        <Note freeCredits={freeCredits} />
      </div>
      <div
        className="lx-feed"
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onPointerDown={(event) => {
          drag.current = event.clientY;
        }}
        onPointerUp={(event) => {
          if (drag.current === null) return;
          const moved = event.clientY - drag.current;
          drag.current = null;
          if (Math.abs(moved) > 24) go(moved < 0 ? 1 : -1);
        }}
      >
        {FEED.map((cut, i) => {
          let offset = i - index;
          if (offset > FEED.length / 2) offset -= FEED.length;
          if (offset < -FEED.length / 2) offset += FEED.length;
          return (
            <button
              key={cut.src}
              type="button"
              tabIndex={Math.abs(offset) === 1 ? 0 : -1}
              className="lx-feed__item"
              data-near={Math.abs(offset) <= 1 ? "" : undefined}
              style={{ "--o": offset, "--a": Math.abs(offset) } as CSSProperties}
              onClick={() => offset !== 0 && go(offset)}
              aria-label={offset === 1 ? "Next clip" : offset === -1 ? "Previous clip" : undefined}
              aria-hidden={Math.abs(offset) > 1 ? true : undefined}
            >
              <ClipCard
                src={cut.src}
                alt=""
                score={cut.score}
                duration={cut.duration}
                caption={cut.caption}
                style={styleFor(styles, cut.presetId)}
                live={offset === 0}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- 3. Before / after: drag between the long episode and its clips ---------- */

const EPISODE = DEMOS[0]!;

function Compare({ styles, freeCredits }: Props) {
  const [ref, onScreen] = useOnScreen<HTMLDivElement>(0.45);
  const stage = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const position = useRef(50);
  const touched = useRef(false);

  const place = useCallback((value: number) => {
    position.current = Math.min(100, Math.max(0, value));
    stage.current?.style.setProperty("--x", `${position.current}%`);
    handle.current?.setAttribute("aria-valuenow", String(Math.round(position.current)));
  }, []);

  // Shows what the divider does once, then waits for a hand.
  useEffect(() => {
    if (!onScreen || touched.current || reduced()) return;
    const keys = [0, 80, 22, 50];
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 2600);
      const span = t * (keys.length - 1);
      const k = Math.min(keys.length - 2, Math.floor(span));
      const local = span - k;
      const eased = local < 0.5 ? 2 * local * local : 1 - (-2 * local + 2) ** 2 / 2;
      place(keys[k]! + (keys[k + 1]! - keys[k]!) * eased);
      if (t < 1 && !touched.current) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [onScreen, place]);

  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const box = stage.current?.getBoundingClientRect();
    if (box) place(((event.clientX - box.left) / box.width) * 100);
  };

  return (
    <div ref={ref} className="lx-close lx-close--compare">
      <Title first="Same video." second="A week of posts." />
      <div
        ref={stage}
        className="lx-compare"
        onPointerDown={(event) => {
          touched.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          follow(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) follow(event);
        }}
      >
        <div className="lx-compare__before">
          <img src={SOURCE_FRAME.src} alt="A wide shot of a two-person podcast" decoding="async" />
          <span className="lx-compare__tag">1 episode · {EPISODE.length}</span>
        </div>
        <div className="lx-compare__after">
          <ol>
            {EPISODE.cuts.map((cut) => (
              <li key={cut.src}>
                <ClipCard
                  src={cut.src}
                  alt=""
                  score={cut.score}
                  duration={cut.duration}
                  caption={cut.caption}
                  style={styleFor(styles, cut.presetId)}
                />
              </li>
            ))}
          </ol>
          <span className="lx-compare__tag">{EPISODE.cuts.length} clips · ready to post</span>
        </div>
        <div
          ref={handle}
          className="lx-compare__handle"
          role="slider"
          tabIndex={0}
          aria-label="Compare the episode with its clips"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={50}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            touched.current = true;
            place(position.current + (event.key === "ArrowLeft" ? -5 : 5));
          }}
        >
          <i aria-hidden="true">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m9 7-5 5 5 5M15 7l5 5-5 5" />
            </svg>
          </i>
        </div>
      </div>
      <div className="lx-compare__cta">
        <LinkForm />
        <Note freeCredits={freeCredits} />
      </div>
    </div>
  );
}

/* ---------- 4. Fan: clips fan out from behind the field ---------- */

const HAND = [DEMOS[1]!.cuts[0]!, DEMOS[0]!.cuts[1]!, DEMOS[0]!.cuts[0]!, DEMOS[0]!.cuts[2]!, DEMOS[3]!.cuts[0]!];

function Fan({ styles, freeCredits }: Props) {
  const [ref, onScreen] = useOnScreen<HTMLDivElement>(0.45);
  const [wide, setWide] = useState(false);
  const state = wide ? "wide" : onScreen ? "open" : "closed";

  return (
    <div
      ref={ref}
      className="lx-close lx-close--fan"
      data-state={state}
      onFocusCapture={() => setWide(true)}
      onBlurCapture={() => setWide(false)}
    >
      <Title first="Your next clip" second="is already recorded." />
      <div className="lx-fan" onPointerEnter={() => setWide(true)} onPointerLeave={() => setWide(false)}>
        <ol className="lx-fan__cards" aria-hidden="true">
          {HAND.map((cut, i) => {
            const k = i - 2;
            return (
              <li key={cut.src} style={{ "--k": k, "--a": Math.abs(k) } as CSSProperties}>
                <ClipCard
                  src={cut.src}
                  alt=""
                  score={cut.score}
                  duration={cut.duration}
                  caption={cut.caption}
                  style={styleFor(styles, cut.presetId)}
                  live={k === 0}
                />
              </li>
            );
          })}
        </ol>
        <div className="lx-fan__field">
          <LinkForm />
        </div>
      </div>
      <Note freeCredits={freeCredits} />
    </div>
  );
}

/* ---------- Review dial ---------- */

export function ClosingVariants(props: Props) {
  const [variant, setVariant] = useState<Variant>("links");
  const [ref, onScreen] = useOnScreen<HTMLElement>(0.2);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("end");
    const match = VARIANTS.find((item) => item.id === value);
    if (match) setVariant(match.id);
  }, []);

  function choose(next: Variant) {
    setVariant(next);
    const url = new URL(window.location.href);
    url.searchParams.set("end", next);
    window.history.replaceState(window.history.state, "", url);
  }

  return (
    <section ref={ref} className="lx-end" aria-labelledby="end-title">
      {variant === "feed" ? (
        <Feed {...props} />
      ) : variant === "compare" ? (
        <Compare {...props} />
      ) : variant === "fan" ? (
        <Fan {...props} />
      ) : (
        <AnyLink {...props} />
      )}
      <div className="lx-dial" data-on={onScreen ? "" : undefined}>
        <span>Closing</span>
        {VARIANTS.map((item, i) => (
          <button key={item.id} type="button" aria-pressed={item.id === variant} onClick={() => choose(item.id)}>
            <em>{i + 1}</em>
            {item.label}
          </button>
        ))}
      </div>
    </section>
  );
}
