/* Deterministic math shared by the Remotion and canvas renderers. */

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Stable pseudo-random in [0, 1) for an integer index and salt. */
export const rand = (i: number, salt = 0) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export const ease = {
  linear: (t: number) => t,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  out: (t: number) => 1 - (1 - t) ** 3,
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  in: (t: number) => t * t * t,
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  /** Critically-damped-ish spring settle with one small overshoot. */
  spring: (t: number) => 1 - Math.exp(-6 * t) * Math.cos(7 * t),
};

/** Eased 0→1 progress of `t` across [a, b]. */
export const ramp = (t: number, a: number, b: number, fn: (x: number) => number = ease.inOut) =>
  fn(clamp((t - a) / (b - a)));

/** 1 inside [a, b] with eased edges of length `f`. */
export const window01 = (t: number, a: number, b: number, f = 0.3, fn = ease.inOut) =>
  Math.min(ramp(t, a - f, a, fn), 1 - ramp(t, b, b + f, fn));

/**
 * Loop-safe oscillator: a sine whose period is rounded so a whole number of
 * cycles fits in `loop` seconds, so every loop's last frame meets its first.
 */
export const osc = (t: number, period: number, loop: number, phase = 0) => {
  const cycles = Math.max(1, Math.round(loop / period));
  return Math.sin((2 * Math.PI * cycles * t) / loop + phase);
};

/** Smooth loop-safe noise built from three incommensurate-looking oscillators. */
export const drift = (t: number, loop: number, seed: number) =>
  (osc(t, 5.3, loop, seed * 1.7) * 0.5 +
    osc(t, 3.1, loop, seed * 2.9) * 0.3 +
    osc(t, 1.9, loop, seed * 4.1) * 0.2);

export const mod = (a: number, n: number) => ((a % n) + n) % n;

export const tc = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
};
