import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

/* Shared cinematic layers: film grain, vignette, light sweeps, gradient mesh. */

const NOISE_SVG = encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='260' height='260'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`,
);

export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.055 }) => {
  const frame = useCurrentFrame();
  // shift the tile in a 4-frame cycle so the grain "boils" like film
  const dx = [0, 9, -7, 4][frame % 4];
  const dy = [0, -6, 5, -9][frame % 4];
  return (
    <AbsoluteFill
      aria-hidden
      style={{
        backgroundImage: `url("data:image/svg+xml,${NOISE_SVG}")`,
        backgroundSize: "260px 260px",
        opacity,
        mixBlendMode: "overlay",
        translate: `${dx}px ${dy}px`,
        pointerEvents: "none",
      }}
    />
  );
};

export const Vignette: React.FC<{ strength?: number }> = ({ strength = 0.55 }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(ellipse at 50% 46%, transparent 52%, rgba(0,0,0,${strength}) 130%)`,
      pointerEvents: "none",
    }}
  />
);

/** Diagonal light band sweeping across the frame between `from` and `to` frames. */
export const Sweep: React.FC<{
  from: number;
  to: number;
  color?: string;
  opacity?: number;
}> = ({ from, to, color = "255,255,255", opacity = 0.16 }) => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [from, to], [-60, 160], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const on = frame >= from && frame <= to;
  return (
    <AbsoluteFill style={{ overflow: "hidden", pointerEvents: "none", opacity: on ? 1 : 0 }}>
      <div
        style={{
          position: "absolute",
          top: "-40%",
          bottom: "-40%",
          width: "34%",
          left: `${x}%`,
          rotate: "18deg",
          background: `linear-gradient(90deg, transparent, rgba(${color},${opacity}), transparent)`,
          mixBlendMode: "screen",
        }}
      />
    </AbsoluteFill>
  );
};

/** Slowly drifting blurred color blobs — depth without WebGL. */
export const Mesh: React.FC<{
  blobs: Array<{ color: string; size: number; x: [number, number]; y: [number, number] }>;
  duration: number;
}> = ({ blobs, duration }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {blobs.map((b, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            width: b.size,
            height: b.size,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${b.color}, transparent 66%)`,
            left: interpolate(frame, [0, duration], [b.x[0], b.x[1]]),
            top: interpolate(frame, [0, duration], [b.y[0], b.y[1]]),
            filter: "blur(6px)",
          }}
        />
      ))}
    </AbsoluteFill>
  );
};

/** Deterministic rising particles (embers / sparks / dust). */
export const Particles: React.FC<{
  count: number;
  color: string;
  width: number;
  height: number;
  duration: number;
  size?: number;
  drift?: number;
}> = ({ count, color, width, height, duration, size = 5, drift = 60 }) => {
  const frame = useCurrentFrame();
  const rand = (i: number, salt: number) => {
    const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {Array.from({ length: count }).map((_, i) => {
        const speed = 0.4 + rand(i, 1) * 0.9;
        const phase = rand(i, 2);
        const p = (frame / duration) * speed + phase;
        const t = p - Math.floor(p); // 0..1 looping
        const x = rand(i, 3) * width + Math.sin((t + phase) * Math.PI * 2) * drift;
        const y = height + 40 - t * (height + 120);
        const s = size * (0.5 + rand(i, 4));
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: s,
              height: s,
              borderRadius: "50%",
              background: color,
              opacity: 0.16 + 0.5 * Math.sin(t * Math.PI),
              filter: "blur(0.6px)",
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
