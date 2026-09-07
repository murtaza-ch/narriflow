import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { C, FONT_DISPLAY, FONT_MONO } from "./theme";
import { Grain, Mesh, Sweep, Vignette } from "./fx";

const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const SIZE = 1200;
const CENTER = SIZE / 2;

const OUTPUTS = [
  { label: "BLOG POST", sub: "SEO Markdown", lines: [0.92, 0.74, 0.86, 0.58], x: -335, y: -330, tilt: -2.5 },
  { label: "X THREAD", sub: "8 tweets", lines: [0.7, 0.88, 0.52], x: 335, y: -330, tilt: 2 },
  { label: "LINKEDIN", sub: "180 words", lines: [0.84, 0.62, 0.75], x: -335, y: 330, tilt: 2 },
  { label: "SHOW NOTES", sub: "timestamped", lines: [0.6, 0.9, 0.72, 0.5], x: 335, y: 330, tilt: -2 },
];

const Card: React.FC<{
  label: string;
  sub: string;
  lines: number[];
  x: number;
  y: number;
  tilt: number;
  delay: number;
}> = ({ label, sub, lines, x, y, tilt, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const t = spring({ frame: frame - delay, fps, config: { damping: 13, stiffness: 90 } });
  const hover = Math.sin((frame + delay * 3) / 22) * 6;

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        width: 386,
        marginLeft: -193,
        marginTop: -148,
        translate: `${x * t}px ${y * t + hover * t}px`,
        scale: String(0.35 + 0.65 * t),
        rotate: `${tilt * t}deg`,
        opacity: Math.min(1, t * 1.4),
        background: "linear-gradient(170deg, rgba(30,36,46,0.98), rgba(20,24,31,0.98))",
        border: `1.5px solid ${C.borderStrong}`,
        borderRadius: 18,
        padding: "30px 34px",
        display: "flex",
        flexDirection: "column",
        gap: 18,
        boxShadow: "0 34px 90px rgba(0,0,0,0.55), inset 0 1px 0 rgba(233,235,238,0.09)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 24, letterSpacing: "0.22em", color: C.accent, textShadow: `0 0 20px ${C.accentDeep}66` }}>
          {label}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 17, letterSpacing: "0.08em", color: C.fgSubtle }}>
          {sub}
        </span>
      </div>
      {lines.map((w, i) => {
        const lt = interpolate(frame, [delay + 0.4 * fps + i * 5, delay + 0.85 * fps + i * 5], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE,
        });
        return (
          <div key={i} style={{ position: "relative", height: 15, overflow: "hidden", borderRadius: 8 }}>
            <div
              style={{
                height: "100%",
                width: `${w * 100}%`,
                borderRadius: 8,
                background: "linear-gradient(90deg, #3A4351, #2B323D)",
                scale: `${lt} 1`,
                transformOrigin: "left",
              }}
            />
            {/* typing shimmer */}
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                width: 60,
                left: `${lt * w * 100 - 6}%`,
                background: `linear-gradient(90deg, transparent, ${C.accent}44, transparent)`,
                opacity: lt > 0 && lt < 1 ? 1 : 0,
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

export const RepurposeBurst: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 13, stiffness: 100 } });
  const burst = 1.3 * fps;

  const sourceScale = interpolate(frame, [burst, burst + 0.6 * fps], [1, 0.86], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const pulse = 1 + Math.sin(frame / 9) * 0.015;

  // connector draw progress per card
  const linkT = (i: number) =>
    interpolate(frame, [burst + i * 5, burst + i * 5 + 0.7 * fps], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE,
    });

  const tagline = spring({ frame: frame - (durationInFrames - 2.1 * fps), fps, config: { damping: 13, stiffness: 110 } });
  const tagOn = frame >= durationInFrames - 2.1 * fps;

  const fadeIO = interpolate(
    frame,
    [0, 0.3 * fps, durationInFrames - 0.4 * fps, durationInFrames - 1],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ background: C.canvas }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${C.surface} 1px, transparent 1px), linear-gradient(90deg, ${C.surface} 1px, transparent 1px)`,
          backgroundSize: "44px 44px",
          opacity: 0.45,
        }}
      />
      <AbsoluteFill style={{ opacity: fadeIO }}>
        <Mesh
          duration={8 * 30}
          blobs={[
            { color: `${C.accentDeep}38`, size: 820, x: [180, 260], y: [180, 240] },
            { color: `${C.timecode}1E`, size: 640, x: [700, 620], y: [760, 700] },
          ]}
        />

        {/* connectors */}
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          style={{ position: "absolute", inset: 0 }}
          aria-hidden="true"
        >
          {OUTPUTS.map((o, i) => {
            const t = linkT(i);
            const x2 = CENTER + o.x * 0.72;
            const y2 = CENTER + o.y * 0.62;
            const len = Math.hypot(x2 - CENTER, y2 - CENTER);
            return (
              <g key={o.label}>
                <line
                  x1={CENTER}
                  y1={CENTER}
                  x2={x2}
                  y2={y2}
                  stroke={C.accentDeep}
                  strokeWidth="2.5"
                  strokeDasharray={len}
                  strokeDashoffset={len * (1 - t)}
                  opacity={0.8}
                  style={{ filter: `drop-shadow(0 0 6px ${C.accentDeep})` }}
                />
                {/* traveling pulse */}
                {t >= 1 && (
                  <circle
                    cx={CENTER + (x2 - CENTER) * ((frame / 20 + i * 0.25) % 1)}
                    cy={CENTER + (y2 - CENTER) * ((frame / 20 + i * 0.25) % 1)}
                    r="5"
                    fill={C.timecode}
                    opacity="0.9"
                    style={{ filter: `drop-shadow(0 0 8px ${C.timecode})` }}
                  />
                )}
              </g>
            );
          })}
        </svg>

        {/* source tile */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: 336,
            height: 206,
            marginLeft: -168,
            marginTop: -103,
            scale: String(enter * sourceScale * pulse),
            background: `linear-gradient(150deg, #1D2536, ${C.canvas})`,
            border: `1.5px solid ${C.accent}`,
            borderRadius: 18,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            zIndex: 2,
            boxShadow: `0 0 70px ${C.accentDeep}77, inset 0 1px 0 rgba(233,235,238,0.12)`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              style={{
                width: 54,
                height: 54,
                borderRadius: 27,
                background: C.accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: `0 0 26px ${C.accentDeep}`,
              }}
            >
              <div
                style={{
                  width: 0,
                  height: 0,
                  borderTop: "12px solid transparent",
                  borderBottom: "12px solid transparent",
                  borderLeft: "19px solid #0A0D2A",
                  marginLeft: 5,
                }}
              />
            </div>
            {/* mini waveform */}
            <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
              {Array.from({ length: 12 }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    width: 6,
                    height: 10 + Math.abs(Math.sin(frame / 5 + i * 0.8)) * 34,
                    borderRadius: 3,
                    background: C.timecode,
                    opacity: 0.75,
                  }}
                />
              ))}
            </div>
          </div>
          <span style={{ fontFamily: FONT_MONO, fontSize: 22, color: C.fgMuted, letterSpacing: "0.08em" }}>
            ep142.mp4 · 47:12
          </span>
        </div>

        {OUTPUTS.map((o, i) => (
          <Card key={o.label} {...o} delay={burst + i * 5} />
        ))}

        {/* tagline */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 66,
            display: "flex",
            justifyContent: "center",
            opacity: tagOn ? tagline : 0,
            translate: `0px ${(1 - tagline) * 26}px`,
          }}
        >
          <span
            style={{
              fontFamily: FONT_DISPLAY,
              fontWeight: 800,
              fontSize: 56,
              letterSpacing: "-0.02em",
              color: C.fg,
              textShadow: "0 6px 40px rgba(0,0,0,0.6)",
            }}
          >
            One recording. <span style={{ color: C.accent }}>Every format.</span>
          </span>
        </div>

        <Sweep from={Math.round(5.6 * fps)} to={Math.round(7 * fps)} opacity={0.14} />
      </AbsoluteFill>
      <Vignette strength={0.55} />
      <Grain />
    </AbsoluteFill>
  );
};
