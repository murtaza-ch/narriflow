/*
 * Procedural "footage" as a renderer-neutral display list. The Remotion side
 * paints it as SVG, the canvas side with Canvas 2D, so both videos show the
 * exact same podcast set. Coordinates: a 1920×1080 source frame.
 */
import { activity, HOST_X, SCRIPT, type Script, speechLevel } from "./script";
import { clamp, drift, osc, rand } from "./math";

export type Grad =
  | { kind: "linear"; x0: number; y0: number; x1: number; y1: number; stops: Array<[number, string]> }
  | { kind: "radial"; cx: number; cy: number; r: number; stops: Array<[number, string]> };
export type Paint = string | Grad;
type Common = { alpha?: number; blend?: "screen" };
export type Op =
  | (Common & { t: "rect"; x: number; y: number; w: number; h: number; r?: number; fill: Paint })
  | (Common & { t: "path"; d: string; fill?: Paint; stroke?: Paint; lw?: number })
  | (Common & { t: "ellipse"; cx: number; cy: number; rx: number; ry: number; fill?: Paint; stroke?: Paint; lw?: number })
  | (Common & { t: "group"; x?: number; y?: number; rot?: number; sx?: number; sy?: number; children: Op[] });

export const SOURCE_W = 1920;
export const SOURCE_H = 1080;
const TABLE_Y = 800;
const HOST_BASE_Y = 870;

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
};
const glow = (cx: number, cy: number, r: number, hex: string, a: number, blend = true): Op => ({
  t: "ellipse",
  cx,
  cy,
  rx: r,
  ry: r,
  fill: { kind: "radial", cx, cy, r, stops: [[0, rgba(hex, a)], [0.45, rgba(hex, a * 0.42)], [1, rgba(hex, 0)]] },
  blend: blend ? "screen" : undefined,
});

/* ——— Host silhouettes (local space: origin at torso base, facing +x) ——— */
const TORSO = "M -205 60 C -205 -80 -165 -186 -72 -220 C -40 -232 42 -232 78 -219 C 168 -186 210 -80 210 60 Z";
const NECK = "M -30 -205 L -25 -282 L 32 -282 L 38 -205 Z";
const HEAD =
  "M 10 -428 C 56 -428 82 -398 82 -356 C 82 -346 88 -338 95 -326 C 97 -320 90 -317 84 -316 C 83 -299 76 -284 62 -274 C 46 -264 26 -261 6 -264 C -40 -269 -62 -304 -62 -346 C -62 -398 -36 -428 10 -428 Z";
const HAIR = [
  // long hair, falls behind the shoulder
  "M 12 -438 C -52 -438 -82 -392 -80 -340 C -78 -292 -90 -246 -112 -206 C -74 -210 -50 -238 -40 -272 C -30 -306 -22 -336 -8 -362 C 22 -388 62 -394 88 -372 C 82 -414 52 -438 12 -438 Z",
  // short crop
  "M 10 -440 C -48 -440 -72 -400 -70 -348 C -60 -368 -50 -388 -28 -398 C 12 -410 54 -404 88 -376 C 84 -418 52 -440 10 -440 Z",
] as const;
const BEARD = "M 76 -306 C 64 -272 36 -256 4 -260 C -28 -266 -48 -286 -56 -314 C -30 -292 24 -286 76 -306 Z";

type HostStyle = { rim: string; key: string; cloth: string; hair: 0 | 1; cup: string };
// `key` is the opaque fill-light tint on the face side (must stay opaque so
// the rim layer underneath never bleeds through).
const HOSTS: HostStyle[] = [
  { rim: "#FFB35C", key: "#262B44", cloth: "#1A1E29", hair: 0, cup: "#FFB35C" },
  { rim: "#7C8CFF", key: "#30282A", cloth: "#181B22", hair: 1, cup: "#5B6CFF" },
];

const bodyParts = (fill: Paint): Op[] => [
  { t: "path", d: TORSO, fill },
  { t: "path", d: NECK, fill },
];
const headParts = (style: HostStyle, fill: Paint): Op[] => [
  { t: "path", d: HAIR[style.hair], fill },
  { t: "path", d: HEAD, fill },
  ...(style.hair === 1 ? [{ t: "path", d: BEARD, fill } as Op] : []),
];

function host(i: 0 | 1, t: number, st: number, loop: number, script: Script): Op {
  const s = HOSTS[i]!;
  const act = activity(st, i, script);
  const level = speechLevel(st, i, script);
  const breathe = 1 + 0.009 * osc(t, 3.7, loop, i * 2);
  const nod =
    act * (2.4 * Math.sin(t * 2 * Math.PI * 1.6 + i) + 1.4 * level) + (1 - act) * 0.9 * osc(t, 4.6, loop, i * 3) - 1.5;
  const headBob = -5 * act * level;
  const lean = 1.2 * act + 0.6 * osc(t, 6.1, loop, i);

  const shoulder = clamp(act) * 4 * Math.sin(t * 2 * Math.PI * 0.9 + i * 2);

  const rim = rgba(s.rim, 0.55 + 0.35 * act);
  const dark: Grad = {
    kind: "linear",
    x0: -200,
    y0: 0,
    x1: 200,
    y1: 0,
    stops: [
      [0, "#0D0F14"],
      [0.62, s.cloth],
      [1, s.key],
    ],
  };
  // Rim light: the silhouette in light colour, covered by the dark body shifted
  // toward the face, leaving a lit edge on the side facing the practical light.
  const lit = (parts: (fill: Paint) => Op[]): Op[] => [...parts(rim), { t: "group", x: 7, y: 2, children: parts(dark) }];

  return {
    t: "group",
    x: HOST_X[i],
    y: HOST_BASE_Y,
    sx: i === 0 ? 1 : -1,
    children: [
      {
        t: "group",
        rot: lean,
        y: shoulder,
        sy: breathe,
        children: [
          ...lit(bodyParts),
          {
            t: "group",
            x: 10,
            y: -280 + headBob,
            rot: nod,
            children: [
              {
                t: "group",
                x: -10,
                y: 280,
                children: [
                  ...lit((fill) => headParts(s, fill)),
                  // headphones: band + ear cup with a coloured ring that pulses with the voice
                  { t: "path", d: "M -60 -352 C -62 -452 84 -456 84 -366", stroke: "#262B36", lw: 15 },
                  { t: "path", d: "M -60 -352 C -62 -452 84 -456 84 -366", stroke: rgba(s.rim, 0.5), lw: 3 },
                  { t: "ellipse", cx: -40, cy: -336, rx: 27, ry: 37, fill: "#1E232D" },
                  { t: "ellipse", cx: -40, cy: -336, rx: 27, ry: 37, stroke: rgba(s.cup, 0.85), lw: 3 },
                  { t: "ellipse", cx: -40, cy: -336, rx: 12, ry: 17, fill: rgba(s.cup, 0.25 + 0.5 * level) },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function mic(i: 0 | 1, st: number, script: Script): Op {
  const level = speechLevel(st, i, script);
  const dir = i === 0 ? 1 : -1;
  const x = HOST_X[i];
  const cx = x + dir * 150;
  const cy = 540;
  const arm = `M ${x + dir * 40} -20 L ${x + dir * 250} 250 L ${cx + dir * 18} ${cy - 44}`;
  return {
    t: "group",
    children: [
      { t: "path", d: arm, stroke: "#1C2029", lw: 16 },
      { t: "path", d: arm, stroke: "rgba(255,255,255,0.08)", lw: 3 },
      {
        t: "group",
        x: cx,
        y: cy,
        rot: dir * -28,
        children: [
          { t: "rect", x: -24, y: -64, w: 48, h: 118, r: 22, fill: "#242935" },
          { t: "rect", x: -24, y: -64, w: 48, h: 60, r: 22, fill: "#2E3441" },
          { t: "rect", x: -3, y: 20, w: 6, h: 6, r: 3, fill: level > 0 ? "#FF4D5E" : "#5A2A30" },
        ],
      },
    ],
  };
}

function steam(t: number, loop: number): Op[] {
  return [0, 1, 2].map((k) => {
    const pts: string[] = [];
    for (let j = 0; j <= 14; j++) {
      const y = 718 - j * 11;
      const x = 950 + k * 12 + 9 * Math.sin(j * 0.55 + osc(t, 2.2, loop, k) * 1.6 + t * 1.6 + k);
      pts.push(`${j === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    return { t: "path", d: pts.join(" "), stroke: "rgba(230,235,245,0.10)", lw: 5, blend: "screen" } as Op;
  });
}

/** Neon waveform sign on the right wall. Flickers on a fixed schedule. */
function neon(t: number, loop: number): Op[] {
  const flick = [1.3, 1.36, 7.9, 7.95].some((f) => Math.abs((t % loop) - f) < 0.04) ? 0.35 : 1;
  const pts: string[] = [];
  for (let j = 0; j <= 28; j++) {
    const x = 1520 + j * 10;
    const amp = [8, 20, 34, 18, 44, 26, 12][j % 7]! * (0.75 + 0.25 * osc(t, 1.4, loop, j));
    pts.push(`${j === 0 ? "M" : "L"} ${x} ${300 + (j % 2 ? amp : -amp)}`);
  }
  const d = pts.join(" ");
  const c = "#7C8CFF";
  return [
    glow(1660, 300, 420, c, 0.34 * flick),
    { t: "path", d, stroke: rgba(c, 0.18 * flick), lw: 26, blend: "screen" },
    { t: "path", d, stroke: rgba(c, 0.45 * flick), lw: 10, blend: "screen" },
    { t: "path", d, stroke: flick < 1 ? "#6D78B8" : "#E6E9FF", lw: 3.5 },
  ];
}

export function podcastScene(t: number, st: number, loop: number, script: Script = SCRIPT): Op[] {
  const cam = {
    x: 960 + 6 * drift(t, loop, 1),
    y: 540 + 4 * drift(t, loop, 2),
    rot: 0.18 * drift(t, loop, 3),
  };
  const bokeh: Op[] = Array.from({ length: 22 }, (_, i) => {
    const warm = rand(i, 1) < 0.45;
    const x = 80 + rand(i, 2) * 1760;
    const y = 90 + rand(i, 3) * 420;
    const r = 18 + rand(i, 4) * 46;
    const tw = 0.5 + 0.5 * osc(t, 2 + rand(i, 5) * 4, loop, i);
    return glow(x, y, r, warm ? "#FFB35C" : "#7C8CFF", 0.10 + 0.14 * tw);
  });
  const slats: Op[] = Array.from({ length: 62 }, (_, i) => ({
    t: "rect",
    x: i * 32 - 12,
    y: 0,
    w: 24,
    h: TABLE_Y,
    fill: i % 2 ? "#12151C" : "#11141A",
  }));

  const lamp: Op[] = [
    { t: "path", d: "M 196 800 L 196 360 L 204 360 L 204 800 Z", fill: "#181B22" },
    {
      t: "path",
      d: "M 150 380 L 180 300 L 222 300 L 252 380 Z",
      fill: { kind: "linear", x0: 0, y0: 300, x1: 0, y1: 380, stops: [[0, "#6B4A2A"], [1, "#FFC27A"]] },
    },
    {
      t: "path",
      d: "M 150 380 L 252 380 L 420 800 L -20 800 Z",
      fill: { kind: "linear", x0: 0, y0: 380, x1: 0, y1: 800, stops: [[0, "rgba(255,190,120,0.16)"], [1, "rgba(255,190,120,0)"]] },
      blend: "screen",
    },
    glow(200, 370, 520, "#FFB35C", 0.36 + 0.02 * osc(t, 0.9, loop)),
  ];

  const table: Op[] = [
    {
      t: "rect",
      x: -40,
      y: TABLE_Y,
      w: 2000,
      h: 320,
      fill: { kind: "linear", x0: 0, y0: TABLE_Y, x1: 0, y1: 1080, stops: [[0, "#1B1F27"], [1, "#0B0D11"]] },
    },
    {
      t: "rect",
      x: -40,
      y: TABLE_Y - 2,
      w: 2000,
      h: 4,
      fill: {
        kind: "linear",
        x0: 0,
        y0: 0,
        x1: 1920,
        y1: 0,
        stops: [[0, "rgba(255,190,120,0.55)"], [0.45, "rgba(255,255,255,0.12)"], [1, "rgba(124,140,255,0.6)"]],
      },
    },
    { t: "group", x: 360, y: 840, sy: 0.18, children: [glow(0, 0, 320, "#FFB35C", 0.2)] },
    { t: "group", x: 1600, y: 840, sy: 0.18, children: [glow(0, 0, 340, "#7C8CFF", 0.2)] },
    // mug
    { t: "rect", x: 928, y: 724, w: 64, h: 80, r: 10, fill: "#262B35" },
    { t: "path", d: "M 992 742 C 1022 742 1022 784 992 784", stroke: "#262B35", lw: 9 },
    { t: "rect", x: 928, y: 724, w: 64, h: 5, r: 2, fill: "rgba(255,255,255,0.14)" },
  ];

  return [
    {
      t: "group",
      x: cam.x,
      y: cam.y,
      rot: cam.rot,
      sx: 1.035,
      sy: 1.035,
      children: [
        {
          t: "group",
          x: -960,
          y: -540,
          children: [
            {
              t: "rect",
              x: -60,
              y: -60,
              w: 2040,
              h: 1200,
              fill: { kind: "linear", x0: 0, y0: 0, x1: 0, y1: 1080, stops: [[0, "#131720"], [1, "#0A0C10"]] },
            },
            ...slats,
            ...bokeh,
            ...neon(t, loop),
            ...lamp,
            host(0, t, st, loop, script),
            host(1, t, st, loop, script),
            ...table,
            ...steam(t, loop),
            mic(0, st, script),
            mic(1, st, script),
          ],
        },
      ],
    },
    // grade: vignette
    {
      t: "rect",
      x: 0,
      y: 0,
      w: SOURCE_W,
      h: SOURCE_H,
      fill: { kind: "radial", cx: 960, cy: 500, r: 1150, stops: [[0.55, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,0.55)"]] },
    },
  ];
}

/** Procedural B-roll: dusk skyline with parallax and a rising metric line. */
export function brollScene(t: number, loop: number): Op[] {
  const layers: Op[] = [];
  const sky: Op = {
    t: "rect",
    x: 0,
    y: 0,
    w: SOURCE_W,
    h: SOURCE_H,
    fill: { kind: "linear", x0: 0, y0: 0, x1: 0, y1: 1080, stops: [[0, "#101640"], [0.55, "#3B2A6B"], [0.8, "#F08A5D"], [1, "#FFD29A"]] },
  };
  layers.push(sky, glow(1200, 820, 380, "#FFD29A", 0.7));
  const pan = (t / loop) * 1;
  [0.25, 0.5, 1].forEach((depth, li) => {
    const color = ["#2A2150", "#1A1638", "#0C0B1C"][li]!;
    const shift = -((pan * 600 * depth) % 600);
    for (let k = -1; k < 5; k++) {
      for (let b = 0; b < 8; b++) {
        const seed = li * 100 + b;
        const w = 50 + rand(seed, 1) * 70;
        const h = (160 + rand(seed, 2) * 360) * (0.6 + li * 0.25);
        const x = shift + k * 600 + b * 75;
        layers.push({ t: "rect", x, y: 1080 - h, w, h, fill: color });
        if (li === 2) {
          for (let wy = 0; wy < h - 30; wy += 26) {
            if (rand(seed * 13 + wy, 3) > 0.62)
              layers.push({ t: "rect", x: x + 10 + (rand(seed + wy, 4) > 0.5 ? 18 : 0), y: 1080 - h + 16 + wy, w: 9, h: 12, fill: "rgba(255,210,150,0.55)" });
          }
        }
      }
    }
  });
  return layers;
}
