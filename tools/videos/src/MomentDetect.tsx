import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { TransitionSeries, linearTiming, springTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { C, FONT_DISPLAY, FONT_MONO } from "./theme";
import { Grain, Mesh, Sweep, Vignette } from "./fx";

const bar = (i: number) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const EASE = Easing.bezier(0.22, 1, 0.36, 1);

const MOMENTS = [
  { at: 0.16, w: 0.09, score: 74 },
  { at: 0.45, w: 0.12, score: 92 },
  { at: 0.73, w: 0.08, score: 87 },
];

const CAPTION_WORDS = ["Stop", "editing", "shorts", "by", "hand", "🔥"];

/* ------------------------------ Scene: scan ------------------------------ */

const ScanScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = interpolate(frame, [0, 0.9 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  const sweep = interpolate(frame, [0.9 * fps, 4.4 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.4, 0, 0.25, 1),
  });

  const W = 1360;
  const BARS = 110;
  const scrubbed = Math.floor(sweep * 47 * 60); // scrub through 47:00 of source
  const mm = String(Math.floor(scrubbed / 60)).padStart(2, "0");
  const ss = String(scrubbed % 60).padStart(2, "0");

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 52,
      }}
    >
      <Mesh
        duration={5.5 * 30}
        blobs={[
          { color: `${C.accentDeep}40`, size: 760, x: [-260, -120], y: [-320, -220] },
          { color: `${C.timecode}22`, size: 620, x: [1200, 1050], y: [620, 500] },
        ]}
      />

      {/* headline */}
      <div
        style={{
          opacity: enter,
          translate: `0px ${(1 - enter) * 26}px`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 18,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 22,
            letterSpacing: "0.3em",
            color: C.timecode,
            textTransform: "uppercase",
          }}
        >
          ● Moment detection — AI pass
        </div>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontWeight: 800,
            fontSize: 96,
            letterSpacing: "-0.03em",
            color: C.fg,
            textShadow: "0 6px 40px rgba(0,0,0,0.5)",
          }}
        >
          47 minutes in.
        </div>
      </div>

      {/* source strip */}
      <div
        style={{
          width: W,
          opacity: enter,
          translate: `0px ${(1 - enter) * 36}px`,
          background: "linear-gradient(180deg, rgba(23,27,33,0.94), rgba(14,16,19,0.94))",
          border: `1.5px solid ${C.border}`,
          borderRadius: 18,
          padding: "32px 40px 34px",
          position: "relative",
          boxShadow: "0 40px 100px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 74,
          }}
        >
          <span style={{ fontFamily: FONT_MONO, fontSize: 23, color: C.fgMuted, letterSpacing: "0.06em" }}>
            SOURCE / podcast_ep142.mp4
          </span>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 26,
              color: C.timecode,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "0.04em",
              textShadow: `0 0 18px ${C.timecode}66`,
            }}
          >
            00:{mm}:{ss}.{String(frame % 30).padStart(2, "0")}
          </span>
        </div>

        <div style={{ position: "relative", height: 170 }}>
          {/* mirrored waveform */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, height: "100%" }}>
            {Array.from({ length: BARS }).map((_, i) => {
              const pos = i / BARS;
              const scanned = pos < sweep;
              const m = MOMENTS.find((mo) => pos >= mo.at && pos <= mo.at + mo.w);
              const h = 26 + bar(i) * 120;
              const near = Math.abs(pos - sweep) < 0.02;
              return (
                <div
                  key={i}
                  style={{
                    width: (W - 80) / BARS - 4,
                    height: h * (near ? 1.18 : 1),
                    borderRadius: 3,
                    background: scanned
                      ? m
                        ? m.score === 92
                          ? `linear-gradient(180deg, ${C.accent}, ${C.accentDeep})`
                          : `linear-gradient(180deg, #7683FF99, ${C.accentDeep}88)`
                        : "linear-gradient(180deg, #3E4756, #2A313C)"
                      : C.raised,
                    boxShadow: scanned && m ? `0 0 16px ${C.accentDeep}88` : "none",
                    opacity: scanned ? 1 : 0.62,
                  }}
                />
              );
            })}
          </div>

          {/* beam trail + playhead */}
          <div
            style={{
              position: "absolute",
              top: -16,
              bottom: -16,
              left: `${Math.max(0, sweep * 100 - 7)}%`,
              width: "7%",
              background: `linear-gradient(90deg, transparent, ${C.timecode}1E)`,
              opacity: sweep > 0 && sweep < 1 ? 1 : 0,
            }}
          />
          <div
            style={{
              position: "absolute",
              top: -18,
              bottom: -18,
              left: `${sweep * 100}%`,
              width: 3,
              background: C.timecode,
              borderRadius: 2,
              boxShadow: `0 0 30px ${C.timecode}, 0 0 60px ${C.timecode}66`,
              opacity: sweep > 0 && sweep < 1 ? 1 : 0,
            }}
          />

          {/* score chips */}
          {MOMENTS.map((m, i) => {
            const hitFrame = (0.9 + (m.at + m.w) * 3.5) * fps;
            const pop = spring({ frame: frame - hitFrame, fps, config: { damping: 11, stiffness: 160 } });
            const hit = frame >= hitFrame;
            const best = m.score === 92;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: `${(m.at + m.w / 2) * 100}%`,
                  top: -64,
                  translate: "-50% 0",
                  scale: String(hit ? pop : 0),
                  opacity: hit ? 1 : 0,
                  background: best ? C.accent : "rgba(36,42,51,0.95)",
                  color: best ? "#0A0D2A" : C.fg,
                  border: `1.5px solid ${best ? "#8B97FF" : C.borderStrong}`,
                  borderRadius: 10,
                  padding: "9px 18px",
                  fontFamily: FONT_MONO,
                  fontSize: 27,
                  fontWeight: 600,
                  boxShadow: best ? `0 0 34px ${C.accentDeep}` : "0 10px 26px rgba(0,0,0,0.45)",
                }}
              >
                {m.score}
              </div>
            );
          })}
        </div>

        {/* footer readout */}
        <div style={{ marginTop: 30, display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 20, color: C.fgSubtle, letterSpacing: "0.14em" }}>
            {sweep >= 1 ? "03 SEGMENTS DETECTED" : "SCANNING TRANSCRIPT…"}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 20, color: sweep >= 1 ? C.karaoke : C.fgSubtle, letterSpacing: "0.14em" }}>
            {sweep >= 1 ? "BEST 92 → RENDER" : `${Math.round(sweep * 100)}%`}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ------------------------------ Scene: clip ------------------------------ */

const ClipScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = interpolate(frame, [0, 0.8 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  const wordAt = (i: number) => 0.8 * fps + i * 0.4 * fps;
  const activeWord = CAPTION_WORDS.reduce((acc, _, i) => (frame >= wordAt(i) ? i : acc), -1);

  const score = Math.round(
    interpolate(frame, [0.5 * fps, 2.2 * fps], [0, 92], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.3, 0.8, 0.3, 1),
    }),
  );

  const donePop = spring({ frame: frame - 3.6 * fps, fps, config: { damping: 10, stiffness: 150 } });
  const done = frame >= 3.6 * fps;

  return (
    <AbsoluteFill
      style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 110 }}
    >
      <Mesh
        duration={4.6 * 30}
        blobs={[
          { color: `${C.accentDeep}4A`, size: 800, x: [980, 1120], y: [-260, -180] },
          { color: `${C.fire}20`, size: 560, x: [-180, -60], y: [560, 640] },
        ]}
      />

      {/* left copy */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 30,
          width: 560,
          opacity: enter,
          translate: `0px ${(1 - enter) * 26}px`,
        }}
      >
        <div style={{ fontFamily: FONT_MONO, fontSize: 22, letterSpacing: "0.3em", color: C.accent, textTransform: "uppercase" }}>
          Clip 02 — best moment
        </div>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontWeight: 800,
            fontSize: 88,
            lineHeight: 1.02,
            letterSpacing: "-0.03em",
            color: C.fg,
            textShadow: "0 6px 40px rgba(0,0,0,0.5)",
          }}
        >
          Cut. Captioned. Scored.
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 6 }}>
          {["9:16", "1:1", "16:9", "4:5"].map((r, i) => {
            const chipPop = spring({ frame: frame - (0.4 * fps + i * 5), fps, config: { damping: 12, stiffness: 170 } });
            return (
              <span
                key={r}
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 25,
                  color: i === 0 ? "#0A0D2A" : C.fgMuted,
                  background: i === 0 ? C.accent : "rgba(23,27,33,0.8)",
                  border: `1.5px solid ${i === 0 ? "#8B97FF" : C.borderStrong}`,
                  borderRadius: 9,
                  padding: "9px 18px",
                  scale: String(chipPop),
                  boxShadow: i === 0 ? `0 0 26px ${C.accentDeep}AA` : "none",
                }}
              >
                {r}
              </span>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, opacity: done ? 1 : 0, scale: String(done ? donePop : 0.6) }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              background: C.karaoke,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#06301B",
              fontSize: 23,
              fontWeight: 800,
              fontFamily: FONT_DISPLAY,
              boxShadow: `0 0 30px ${C.karaoke}66`,
            }}
          >
            ✓
          </div>
          <span style={{ fontFamily: FONT_MONO, fontSize: 25, color: C.fgMuted, letterSpacing: "0.06em" }}>
            RENDERED · 0:34 · ALL RATIOS
          </span>
        </div>
      </div>

      {/* phone */}
      <div
        style={{
          width: 442,
          height: 786,
          borderRadius: 34,
          border: "1.5px solid #39424F",
          background: `linear-gradient(160deg, #1B2233 0%, ${C.canvas} 55%, #0F1B2E 100%)`,
          position: "relative",
          overflow: "hidden",
          opacity: enter,
          scale: String(0.93 + enter * 0.07),
          rotate: `${(1 - enter) * 3}deg`,
          boxShadow: `0 50px 140px rgba(0,0,0,0.6), 0 0 80px ${C.accentDeep}33, inset 0 1px 0 rgba(233,235,238,0.14)`,
        }}
      >
        {/* notch */}
        <div
          style={{
            position: "absolute",
            top: 14,
            left: "50%",
            translate: "-50% 0",
            width: 120,
            height: 26,
            borderRadius: 14,
            background: "#05070A",
            zIndex: 3,
          }}
        />
        {/* moving ambience inside the phone */}
        <Mesh
          duration={4.6 * 30}
          blobs={[
            { color: `${C.accentDeep}66`, size: 460, x: [-140, -40], y: [-60, 60] },
            { color: `${C.karaoke}1C`, size: 380, x: [220, 120], y: [520, 430] },
          ]}
        />
        {/* speaker avatar with pulse ring */}
        <div style={{ position: "absolute", top: 140, left: "50%", translate: "-50% 0" }}>
          <div
            style={{
              position: "absolute",
              inset: -16 - (frame % 30) * 0.8,
              borderRadius: "50%",
              border: `2px solid ${C.accent}`,
              opacity: Math.max(0, 0.5 - (frame % 30) / 44),
            }}
          />
          <div
            style={{
              width: 200,
              height: 200,
              borderRadius: "50%",
              background: "linear-gradient(140deg, #2A3346, #1A2130)",
              border: `1.5px solid ${C.borderStrong}`,
              boxShadow: "inset 0 2px 20px rgba(233,235,238,0.06)",
            }}
          />
        </div>
        {/* captions */}
        <div
          style={{
            position: "absolute",
            left: 28,
            right: 28,
            bottom: 160,
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: "8px 14px",
          }}
        >
          {CAPTION_WORDS.map((w, i) => {
            const on = i === activeWord;
            const seen = i <= activeWord;
            const pop = spring({ frame: frame - wordAt(i), fps, config: { damping: 12, stiffness: 200 } });
            return (
              <span
                key={i}
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontWeight: 800,
                  fontSize: 54,
                  textTransform: "uppercase",
                  letterSpacing: "-0.01em",
                  color: on ? C.karaoke : seen ? C.fg : "rgba(233,235,238,0.28)",
                  scale: String(seen ? 0.8 + pop * 0.2 + (on ? 0.1 : 0) : 1),
                  textShadow: on
                    ? `0 0 30px ${C.karaoke}88, 0 4px 26px rgba(0,0,0,0.7)`
                    : "0 4px 26px rgba(0,0,0,0.7)",
                }}
              >
                {w}
              </span>
            );
          })}
        </div>
        {/* score ring */}
        <div style={{ position: "absolute", top: 58, right: 24 }}>
          <svg width="84" height="84" viewBox="0 0 84 84" aria-hidden="true">
            <circle cx="42" cy="42" r="35" stroke="rgba(233,235,238,0.16)" strokeWidth="5" fill="rgba(10,13,42,0.5)" />
            <circle
              cx="42"
              cy="42"
              r="35"
              stroke={C.accent}
              strokeWidth="5"
              fill="none"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 35}
              strokeDashoffset={2 * Math.PI * 35 * (1 - score / 100)}
              transform="rotate(-90 42 42)"
              style={{ filter: `drop-shadow(0 0 8px ${C.accentDeep})` }}
            />
            <text
              x="42"
              y="50"
              textAnchor="middle"
              fontFamily={FONT_MONO}
              fontSize="26"
              fontWeight="600"
              fill={C.fg}
            >
              {score}
            </text>
          </svg>
        </div>
        {/* progress */}
        <div style={{ position: "absolute", left: 26, right: 26, bottom: 36, height: 6, borderRadius: 3, background: "rgba(233,235,238,0.16)" }}>
          <div
            style={{
              height: "100%",
              width: `${interpolate(frame, [0, 4.4 * fps], [4, 100], { extrapolateRight: "clamp" })}%`,
              borderRadius: 3,
              background: `linear-gradient(90deg, ${C.karaoke}, #7FFFC4)`,
              boxShadow: `0 0 14px ${C.karaoke}77`,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ----------------------------- Scene: lockup ----------------------------- */

const LockupScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 14, stiffness: 90 } });
  const rule = interpolate(frame, [0.2 * fps, 1 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const tag = interpolate(frame, [0.5 * fps, 1.2 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 42 }}>
      <Mesh
        duration={2.4 * 30}
        blobs={[{ color: `${C.accentDeep}3A`, size: 900, x: [350, 350], y: [50, 20] }]}
      />
      <div style={{ width: 640, height: 2, background: C.borderStrong, scale: `${rule} 1` }} />
      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontWeight: 800,
          fontSize: 130,
          letterSpacing: "-0.04em",
          color: C.fg,
          opacity: enter,
          translate: `0px ${(1 - enter) * 30}px`,
          textShadow: "0 8px 60px rgba(0,0,0,0.6)",
          position: "relative",
        }}
      >
        narriflow<span style={{ color: C.accent }}>.</span>
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 28,
          color: C.fgMuted,
          letterSpacing: `${0.5 - tag * 0.36}em`,
          textTransform: "uppercase",
          opacity: tag,
        }}
      >
        Find the moments · Ship the clips
      </div>
      <div style={{ width: 640, height: 2, background: C.borderStrong, scale: `${rule} 1` }} />
      <Sweep from={Math.round(0.9 * fps)} to={Math.round(2 * fps)} opacity={0.22} />
    </AbsoluteFill>
  );
};

/* --------------------------------- root ---------------------------------- */

export const MomentDetect: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const fadeIO = interpolate(
    frame,
    [0, 0.35 * fps, durationInFrames - 0.45 * fps, durationInFrames - 1],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ background: C.canvas }}>
      {/* base grid */}
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${C.surface} 1px, transparent 1px), linear-gradient(90deg, ${C.surface} 1px, transparent 1px)`,
          backgroundSize: "44px 44px",
          opacity: 0.45,
        }}
      />
      <AbsoluteFill style={{ opacity: fadeIO }}>
        <TransitionSeries>
          <TransitionSeries.Sequence durationInFrames={5.6 * fps}>
            <ScanScene />
          </TransitionSeries.Sequence>
          <TransitionSeries.Transition
            presentation={slide({ direction: "from-right" })}
            timing={springTiming({ config: { damping: 200 }, durationInFrames: 16 })}
          />
          <TransitionSeries.Sequence durationInFrames={4.9 * fps}>
            <ClipScene />
          </TransitionSeries.Sequence>
          <TransitionSeries.Transition
            presentation={fade()}
            timing={linearTiming({ durationInFrames: 12 })}
          />
          <TransitionSeries.Sequence durationInFrames={2.9 * fps}>
            <LockupScene />
          </TransitionSeries.Sequence>
        </TransitionSeries>
      </AbsoluteFill>
      <Vignette strength={0.6} />
      <Grain />
    </AbsoluteFill>
  );
};
