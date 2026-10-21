"use client";

import { type CSSProperties, type RefObject, useRef, useState } from "react";
import type { CaptionStyle } from "./caption-styles";
import { Caption, ScoreChip, styleFor } from "./clip-card";
import { DEMOS, PLATFORMS, SOURCE_FRAME, STEPS } from "./landing-data";
import { ScrollTrigger, scrollToTarget, useScene } from "./motion";
import { PlatformIcon } from "./platform-icon";

const EPISODE = DEMOS[0]!;
const CUTS = EPISODE.cuts;

function seconds(time: string) {
  return time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

function clock(total: number) {
  const s = Math.floor(total % 60);
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const LENGTH = seconds(EPISODE.length);

/** Each step's block on the timeline, as fractions of its width. */
const PHASES = [
  { label: "Import", note: `${EPISODE.length} · 2 speakers`, from: 0, to: 0.23 },
  { label: "Find moments", note: `${CUTS.length} picked`, from: 0.24, to: 0.53 },
  { label: "Edit", note: "9:16 · Bold Pop", from: 0.54, to: 0.76 },
  { label: "Publish", note: `${PLATFORMS.length} platforms`, from: 0.77, to: 1 },
] as const;

/** Where a moment counts as found: as the moments block plays through it. */
const FOUND_AT = CUTS.map((_, k) => PHASES[1].from + (k / CUTS.length) * (PHASES[1].to - PHASES[1].from) + 0.01);

/** The section scrolls this share of its travel before the playhead moves, and holds the same at the end. */
const HOLD = 0.04;

const WAVE = Array.from({ length: 160 }, (_, i) => {
  const value = Math.abs(Math.sin(i * 0.37) * Math.cos(i * 0.11) + 0.35 * Math.sin(i * 1.7));
  return Math.round((0.18 + Math.min(value, 1) * 0.82) * 100) / 100;
});

const TICKS = Array.from({ length: Math.floor(LENGTH / 120) + 1 }, (_, i) => i * 120);

const SLOTS = ["Tue 9:00", "Wed 12:30", "Thu 18:00"];

/** The current step's progress, as a thin line along the screen's bottom edge. */
function Progress({ step }: { step: number }) {
  return (
    <span className="lx-mon__progress" style={{ "--f": `var(--p${step})` } as CSSProperties}>
      <i />
    </span>
  );
}

function ImportScene({ percent }: { percent: RefObject<HTMLElement | null> }) {
  return (
    <>
      <img src={SOURCE_FRAME.src} alt="" loading="lazy" decoding="async" />
      <span className="lx-mon__pill lx-mon__pill--top lx-mon__url">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L10 5M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1" />
        </svg>
        {EPISODE.link}
      </span>
      <p className="lx-mon__pill lx-mon__pill--bottom">
        Transcribing <b ref={percent}>0%</b>
      </p>
      <Progress step={0} />
    </>
  );
}

function MomentsScene({ moment }: { moment: number }) {
  const cut = CUTS[moment] ?? CUTS[0]!;
  return (
    <>
      {CUTS.map((item, k) => (
        <img
          key={item.src}
          className={k === moment ? "is-on" : undefined}
          src={item.src}
          alt=""
          loading="lazy"
          decoding="async"
        />
      ))}
      <div className="lx-mon__moment" key={cut.src}>
        <ScoreChip score={cut.score} />
        <q className="lx-serif">{cut.caption}</q>
      </div>
      <Progress step={1} />
    </>
  );
}

function EditScene({ style, playing }: { style: CaptionStyle; playing: boolean }) {
  return (
    <>
      <img className="lx-mon__under" src={SOURCE_FRAME.src} alt="" loading="lazy" decoding="async" />
      <img className="lx-mon__crop" src={SOURCE_FRAME.src} alt="" loading="lazy" decoding="async" />
      <div className="lx-mon__frame">
        <span className="lx-mon__pill">9:16 · {style.name}</span>
        <div className="lx-mon__cap">
          <Caption text={CUTS[0]!.caption} style={style} playing={playing} />
        </div>
      </div>
      <Progress step={2} />
    </>
  );
}

function PublishScene() {
  return (
    <>
      <img className="lx-mon__under" src={SOURCE_FRAME.src} alt="" loading="lazy" decoding="async" />
      <span className="lx-mon__pill lx-mon__pill--top">{CUTS.length} clips scheduled</span>
      <div className="lx-mon__posts">
        {CUTS.map((cut, k) => {
          const platform = PLATFORMS[k] ?? PLATFORMS[0]!;
          return (
            <div key={cut.src} className="lx-mon__post" style={{ "--k": k } as CSSProperties}>
              <img src={cut.src} alt="" loading="lazy" decoding="async" />
              <p className="lx-mon__when">
                <PlatformIcon id={platform.id} />
                {SLOTS[k]}
              </p>
            </div>
          );
        })}
      </div>
      <Progress step={3} />
    </>
  );
}

const TRACK_NAMES = { steps: "Steps", video: "Video", audio: "Audio" } as const;

function TrackHead({ kind }: { kind: keyof typeof TRACK_NAMES }) {
  return (
    <span className="lx-tl__head" aria-hidden="true">
      <TrackIcon kind={kind} />
      {TRACK_NAMES[kind]}
    </span>
  );
}

function TrackIcon({ kind }: { kind: keyof typeof TRACK_NAMES }) {
  return (
    <svg className="lx-tl__icon" viewBox="0 0 24 24" aria-hidden="true">
      {kind === "steps" ? (
        <path d="M5 19 15 9m2-5 .6 1.4L19 6l-1.4.6L17 8l-.6-1.4L15 6l1.4-.6Zm3 6 .5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5ZM10 3l.5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5Z" />
      ) : kind === "video" ? (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
          <path d="m10 9 5 3-5 3Z" />
        </>
      ) : (
        <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
      )}
    </svg>
  );
}

/**
 * How it works as an editor timeline. The section pins while scrolling moves
 * a playhead across one episode; the monitor shows the step under it.
 */
export function HowItWorks({ styles }: { styles: Record<string, CaptionStyle> }) {
  const ref = useRef<HTMLElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const percent = useRef<HTMLElement>(null);
  const pinned = useRef(false);
  const [step, setStep] = useState(0);
  const [moment, setMoment] = useState(0);
  const [done, setDone] = useState(false);

  // Scroll writes CSS variables every frame; React state only changes at step boundaries.
  function apply(p: number) {
    const root = ref.current;
    if (!root) return;
    root.style.setProperty("--p", p.toFixed(4));
    let index = 0;
    PHASES.forEach((phase, i) => {
      root.style.setProperty(`--p${i}`, clamp01((p - phase.from) / (phase.to - phase.from)).toFixed(4));
      if (p >= phase.from) index = i;
    });
    const found = FOUND_AT.filter((at) => p >= at).length;
    setStep(index);
    setMoment(Math.max(0, found - 1));
    setDone(p >= 0.995);
    if (time.current) time.current.textContent = clock(p * LENGTH);
    if (percent.current) percent.current.textContent = `${Math.round(clamp01(p / PHASES[0].to) * 100)}%`;
  }

  useScene(ref, ({ motion }, root) => {
    pinned.current = motion;
    if (!motion) {
      apply(PHASES[0].to);
      return;
    }
    const triggers = [
      ScrollTrigger.create({
        trigger: root,
        start: "top top",
        end: "bottom bottom",
        onUpdate: (self) => apply(clamp01((self.progress - HOLD) / (1 - 2 * HOLD))),
      }),
      // The tracks fill in as the section arrives.
      ScrollTrigger.create({ trigger: root, start: "top 70%", end: "bottom top", toggleClass: "is-in" }),
    ];
    apply(0);
    return () => {
      for (const trigger of triggers) trigger.kill();
    };
  });

  function show(i: number) {
    const phase = PHASES[i];
    const root = ref.current;
    if (!phase || !root) return;
    if (!pinned.current) {
      apply(phase.to);
      return;
    }
    const top = root.getBoundingClientRect().top + window.scrollY;
    const travel = root.offsetHeight - window.innerHeight;
    const target = phase.from + (phase.to - phase.from) * 0.6;
    scrollToTarget(top + (HOLD + target * (1 - 2 * HOLD)) * travel);
  }

  const current = STEPS[step] ?? STEPS[0];
  const scenes = [
    <ImportScene key="import" percent={percent} />,
    <MomentsScene key="moments" moment={moment} />,
    <EditScene key="edit" style={styleFor(styles, "bold-pop")} playing={step === 2} />,
    <PublishScene key="publish" />,
  ];

  return (
    <section ref={ref} className="lx-how" id="how" aria-labelledby="how-title">
      <div className="lx-how__stage">
        <div className="lx-how__top lx-container">
          <div className="lx-how__copy" data-reveal>
            <p className="lx-eyebrow">How it works</p>
            <h2 id="how-title" className="lx-serif lx-h2">
              From one long video
              <br />
              <span className="lx-dim">to a week of posts.</span>
            </h2>
            <div className="lx-how__now" key={step} aria-hidden="true">
              <h3>{current.title}</h3>
              <p>{current.body}</p>
            </div>
            <ol className="lx-sr">
              {STEPS.map((item) => (
                <li key={item.title}>
                  {item.title}. {item.body}
                </li>
              ))}
            </ol>
          </div>

          <figure className="lx-monitor" data-reveal aria-hidden="true">
            <div className="lx-monitor__screen">
              {scenes.map((scene, i) => (
                <div key={scene.key} className={`lx-mon lx-mon--${scene.key}${i === step ? " is-on" : ""}`}>
                  {scene}
                </div>
              ))}
            </div>
          </figure>
        </div>

        <div className="lx-tl">
          <div className="lx-tl__ruler" aria-hidden="true">
            {TICKS.map((at) => {
              const major = at % 600 === 0;
              return (
                <i key={at} className={major ? "is-major" : undefined} style={{ left: `${(at / LENGTH) * 100}%` }}>
                  {major ? <span>{clock(at)}</span> : null}
                </i>
              );
            })}
          </div>

          <div className="lx-tl__track lx-tl__track--steps">
            <TrackHead kind="steps" />
            <fieldset className="lx-tl__lane">
              <legend className="lx-sr">Steps</legend>
              {PHASES.map((phase, i) => (
                <button
                  key={phase.label}
                  type="button"
                  className={`lx-tl__block${i === step ? " is-on" : ""}${i < step || done ? " is-past" : ""}`}
                  style={{ left: `${phase.from * 100}%`, width: `${(phase.to - phase.from) * 100}%`, "--i": i } as CSSProperties}
                  aria-pressed={i === step}
                  onClick={() => show(i)}
                >
                  <i className="lx-tl__state" aria-hidden="true" />
                  {phase.label}
                </button>
              ))}
            </fieldset>
          </div>

          <div className="lx-tl__track lx-tl__track--video" aria-hidden="true">
            <TrackHead kind="video" />
            <div className="lx-tl__lane">
              {PHASES.map((phase, i) => (
                <div
                  key={phase.label}
                  className={`lx-tl__strip lx-tl__strip--${i}`}
                  style={
                    {
                      left: `${phase.from * 100}%`,
                      width: `${(phase.to - phase.from) * 100}%`,
                      "--from": phase.from,
                      "--to": phase.to,
                      "--i": i,
                    } as CSSProperties
                  }
                >
                  <div className="lx-tl__tiles">
                    {i === 0
                      ? ["0% 40%", "33% 40%", "66% 40%", "100% 40%"].map((position) => (
                          <span key={position}>
                            <img src={SOURCE_FRAME.src} alt="" loading="lazy" style={{ objectPosition: position }} />
                          </span>
                        ))
                      : null}
                    {i === 1
                      ? CUTS.map((cut, k) => (
                          <span key={cut.src} style={{ "--at": FOUND_AT[k] } as CSSProperties}>
                            <img src={cut.src} alt="" loading="lazy" />
                            <em>{cut.score}</em>
                          </span>
                        ))
                      : null}
                    {i === 2
                      ? [...CUTS, ...CUTS].map((cut, k) => (
                          <span key={`${cut.src}-${k}`} className="lx-tl__tall">
                            <img src={cut.src} alt="" loading="lazy" />
                            <i />
                          </span>
                        ))
                      : null}
                    {i === 3
                      ? PLATFORMS.map((platform, k) => (
                          <span key={platform.id} className="lx-tl__tall">
                            <img src={CUTS[k % CUTS.length]!.src} alt="" loading="lazy" />
                            <b>
                              <PlatformIcon id={platform.id} />
                            </b>
                          </span>
                        ))
                      : null}
                  </div>
                  <div className="lx-tl__bar">
                    <i />
                  </div>
                  <small>{phase.note}</small>
                </div>
              ))}
            </div>
          </div>

          <div className="lx-tl__track lx-tl__track--audio" aria-hidden="true">
            <TrackHead kind="audio" />
            <div className="lx-tl__lane">
              {CUTS.map((cut, k) => (
                <span
                  key={cut.src}
                  className="lx-tl__hit"
                  style={
                    {
                      left: `${(seconds(cut.at) / LENGTH) * 100}%`,
                      width: `${Math.max(0.8, (seconds(cut.duration) / LENGTH) * 100)}%`,
                      "--at": FOUND_AT[k],
                    } as CSSProperties
                  }
                />
              ))}
              {["lx-tl__wave", "lx-tl__wave lx-tl__wave--played"].map((className) => (
                <svg
                  key={className}
                  className={className}
                  viewBox={`0 0 ${WAVE.length} 40`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {WAVE.map((height, i) => (
                    <rect key={i} x={i + 0.2} width={0.6} y={20 - height * 18} height={height * 36} rx={0.3} />
                  ))}
                </svg>
              ))}
            </div>
          </div>

          <div className="lx-tl__played" aria-hidden="true">
            <span ref={time} className="lx-tl__time">
              0:00
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
