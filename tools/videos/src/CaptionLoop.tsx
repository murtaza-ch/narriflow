import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { TransitionSeries, springTiming } from "@remotion/transitions";
import { slide } from "@remotion/transitions/slide";
import { C, FONT_DISPLAY, FONT_MONO } from "./theme";
import { Grain, Mesh, Particles, Sweep, Vignette } from "./fx";

const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const SEG = 3.2; // seconds per preset segment
const W = 1080;
const H = 1920;

type Preset = {
  name: string;
  words: string[];
  active: string;
  base: string;
  bg: string;
  blobs: Array<{ color: string; size: number; x: [number, number]; y: [number, number] }>;
  particles?: { color: string; count: number };
  uppercase?: boolean;
  glow: string;
};

const PRESETS: Preset[] = [
  {
    name: "KARAOKE",
    words: ["We", "grew", "this", "with", "one", "clip"],
    active: C.karaoke,
    base: C.fg,
    bg: `linear-gradient(170deg, #10192E 0%, ${C.canvas} 52%, #0A1B24 100%)`,
    blobs: [
      { color: `${C.karaoke}20`, size: 900, x: [-320, -180], y: [-200, -80] },
      { color: `${C.timecode}26`, size: 700, x: [620, 480], y: [1250, 1100] },
    ],
    particles: { color: `${C.karaoke}55`, count: 16 },
    uppercase: true,
    glow: `${C.karaoke}77`,
  },
  {
    name: "FIRE",
    words: ["Stop", "editing", "shorts", "by", "hand", "🔥"],
    active: "#FFB03A",
    base: "#FFEBD9",
    bg: `linear-gradient(170deg, #2A1310 0%, ${C.canvas} 50%, #2B150A 100%)`,
    blobs: [
      { color: "#FF6A2B33", size: 940, x: [-300, -160], y: [1150, 950] },
      { color: "#FFB03A22", size: 680, x: [560, 640], y: [-160, -60] },
    ],
    particles: { color: "#FF8A4DAA", count: 26 },
    uppercase: true,
    glow: "#FF8A4D88",
  },
  {
    name: "LUXE GOLD",
    words: ["Let", "the", "AI", "find", "the", "moment"],
    active: C.gold,
    base: "#F6F0DF",
    bg: `linear-gradient(170deg, #1D1A11 0%, ${C.canvas} 50%, #191307 100%)`,
    blobs: [
      { color: `${C.gold}26`, size: 860, x: [520, 380], y: [-220, -100] },
      { color: `${C.gold}14`, size: 720, x: [-260, -140], y: [1200, 1050] },
    ],
    particles: { color: `${C.gold}66`, count: 14 },
    glow: `${C.gold}88`,
  },
];

const PresetSegment: React.FC<{ preset: Preset; index: number }> = ({ preset, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = interpolate(frame, [0, 0.5 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  const wordAt = (i: number) => 0.45 * fps + i * 0.36 * fps;
  const activeWord = preset.words.reduce((acc, _, i) => (frame >= wordAt(i) ? i : acc), -1);

  const chipPop = spring({ frame: frame - 4, fps, config: { damping: 12, stiffness: 160 } });

  return (
    <AbsoluteFill style={{ background: preset.bg }}>
      <Mesh duration={SEG * 30} blobs={preset.blobs} />
      {preset.particles && (
        <Particles
          count={preset.particles.count}
          color={preset.particles.color}
          width={W}
          height={H}
          duration={SEG * 30 * 2}
          size={7}
          drift={40}
        />
      )}

      {/* preset chip */}
      <div style={{ position: "absolute", top: 128, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            scale: String(chipPop),
            background: "rgba(10,13,20,0.55)",
            border: `2px solid ${preset.active}66`,
            borderRadius: 16,
            padding: "16px 32px",
            boxShadow: `0 0 40px ${preset.active}22`,
            backdropFilter: "blur(6px)",
          }}
        >
          <span style={{ width: 12, height: 12, borderRadius: 6, background: preset.active, boxShadow: `0 0 14px ${preset.active}` }} />
          <span style={{ fontFamily: FONT_MONO, fontSize: 32, letterSpacing: "0.3em", color: preset.active }}>
            {preset.name}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 22, letterSpacing: "0.12em", color: C.fgSubtle }}>
            {String(index + 1).padStart(2, "0")}/12
          </span>
        </div>
      </div>

      {/* speaker avatar + pulse rings */}
      <div style={{ position: "absolute", top: 420, left: "50%", translate: "-50% 0", opacity: enter }}>
        {[0, 1].map((ring) => (
          <div
            key={ring}
            style={{
              position: "absolute",
              inset: -14 - ((frame + ring * 15) % 30) * 1.4,
              borderRadius: "50%",
              border: `2px solid ${preset.active}`,
              opacity: Math.max(0, 0.42 - ((frame + ring * 15) % 30) / 52),
            }}
          />
        ))}
        <div
          style={{
            width: 360,
            height: 360,
            borderRadius: "50%",
            background: "linear-gradient(140deg, #2A3346, #161C28)",
            border: `2px solid ${C.borderStrong}`,
            boxShadow: "inset 0 3px 30px rgba(233,235,238,0.07), 0 30px 80px rgba(0,0,0,0.5)",
          }}
        />
        {/* waveform arc under avatar */}
        <div style={{ position: "absolute", bottom: -70, left: "50%", translate: "-50% 0", display: "flex", gap: 7, alignItems: "flex-end" }}>
          {Array.from({ length: 17 }).map((_, i) => {
            const h = 14 + Math.abs(Math.sin(frame / 4 + i * 0.9)) * 44;
            return (
              <div
                key={i}
                style={{ width: 7, height: h, borderRadius: 4, background: preset.active, opacity: 0.4 + 0.5 * Math.abs(Math.sin(frame / 6 + i)) }}
              />
            );
          })}
        </div>
      </div>

      {/* captions */}
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          top: 1010,
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "12px 24px",
        }}
      >
        {preset.words.map((w, i) => {
          const on = i === activeWord;
          const seen = i <= activeWord;
          const pop = spring({ frame: frame - wordAt(i), fps, config: { damping: 11, stiffness: 210 } });
          return (
            <span
              key={i}
              style={{
                fontFamily: FONT_DISPLAY,
                fontWeight: 800,
                fontSize: 98,
                lineHeight: 1.12,
                textTransform: preset.uppercase ? "uppercase" : "none",
                letterSpacing: "-0.01em",
                color: on ? preset.active : seen ? preset.base : `${preset.base}3A`,
                scale: String(seen ? 0.78 + pop * 0.22 + (on ? 0.1 : 0) : 1),
                rotate: on ? `${Math.sin(frame / 3) * 1.2}deg` : "0deg",
                textShadow: on
                  ? `0 0 44px ${preset.glow}, 0 8px 46px rgba(0,0,0,0.7)`
                  : "0 8px 46px rgba(0,0,0,0.7)",
                display: "inline-block",
              }}
            >
              {w}
            </span>
          );
        })}
      </div>

      {/* footer: score + progress */}
      <div style={{ position: "absolute", left: 64, right: 64, bottom: 110, display: "flex", flexDirection: "column", gap: 26, opacity: enter }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 30, color: C.fgMuted, letterSpacing: "0.14em" }}>
            WORD-SYNCED · PREVIEW = EXPORT
          </span>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 34,
              fontWeight: 600,
              color: "#0A0D2A",
              background: C.accent,
              borderRadius: 12,
              padding: "10px 22px",
              boxShadow: `0 0 30px ${C.accentDeep}AA`,
            }}
          >
            92
          </span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: "rgba(233,235,238,0.15)" }}>
          <div
            style={{
              height: "100%",
              borderRadius: 4,
              width: `${interpolate(frame, [0, SEG * fps], [3, 100])}%`,
              background: `linear-gradient(90deg, ${preset.active}, ${preset.active}88)`,
              boxShadow: `0 0 16px ${preset.glow}`,
            }}
          />
        </div>
      </div>

      <Sweep from={Math.round(0.5 * fps)} to={Math.round(1.6 * fps)} opacity={0.1} />
    </AbsoluteFill>
  );
};

export const CaptionLoop: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const fadeIO = interpolate(
    frame,
    [0, 0.3 * fps, durationInFrames - 0.3 * fps, durationInFrames - 1],
    [0.5, 1, 1, 0.5],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (
    <AbsoluteFill style={{ background: C.canvas }}>
      <AbsoluteFill style={{ opacity: fadeIO }}>
        <TransitionSeries>
          {PRESETS.flatMap((p, i) => {
            const seq = (
              <TransitionSeries.Sequence key={p.name} durationInFrames={SEG * fps}>
                <PresetSegment preset={p} index={i * 2} />
              </TransitionSeries.Sequence>
            );
            if (i === 0) return [seq];
            return [
              <TransitionSeries.Transition
                key={`t-${p.name}`}
                presentation={slide({ direction: i % 2 ? "from-bottom" : "from-top" })}
                timing={springTiming({ config: { damping: 200 }, durationInFrames: 12 })}
              />,
              seq,
            ];
          })}
        </TransitionSeries>
      </AbsoluteFill>
      <Vignette strength={0.5} />
      <Grain opacity={0.05} />
    </AbsoluteFill>
  );
};
