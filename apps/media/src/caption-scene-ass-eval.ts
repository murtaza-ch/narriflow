/**
 * What a libass event's override tags imply at a time: a small interpreter of the tags the Scene
 * Style writer emits (`\pos`, `\move`, `\fscx`, `\fscy`, `\frz`, `\frx`, `\fry`, `\fax`, `\blur`,
 * `\1c`, `\3c`, `\1a`, `\3a`, `\clip`, `\iclip`, each possibly inside `\t(t1,t2,...)`). The writer's
 * frame-exactness test compares this with `evaluatePiece`; the real libass is checked by the
 * primitives sheet.
 */

export interface AssEventState {
  x: number;
  y: number;
  fscx: number;
  fscy: number;
  frz: number;
  frx: number;
  fry: number;
  fax: number;
  blur: number;
  /** `#RRGGBB`. */
  c1: string;
  c3: string;
  /** 0..255 alpha bytes (255 transparent). */
  a1: number;
  a3: number;
  clip: { x1: number; y1: number; x2: number; y2: number; inverse: boolean } | null;
  org: { x: number; y: number } | null;
}

const NUMERIC = ["fscx", "fscy", "frz", "frx", "fry", "fax", "blur"] as const;

function colourOf(arg: string): string {
  const hex = arg.replace(/[&H]/g, "").padStart(6, "0");
  return `#${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase();
}
const alphaOf = (arg: string) => Number.parseInt(arg.replace(/[&H]/g, ""), 16);
const mix = (a: number, b: number, p: number) => a + (b - a) * p;
const mixColour = (from: string, to: string, p: number) =>
  `#${[0, 1, 2].map((at) => Math.round(mix(Number.parseInt(from.slice(1 + 2 * at, 3 + 2 * at), 16), Number.parseInt(to.slice(1 + 2 * at, 3 + 2 * at), 16), p)).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** Splits `\a1\b(2,3)\c` into tags with parenthesised arguments kept whole. */
function tagsOf(block: string): { name: string; args: string }[] {
  const tags: { name: string; args: string }[] = [];
  let at = 0;
  while (at < block.length) {
    if (block[at] !== "\\") {
      at++;
      continue;
    }
    let end = at + 1;
    let depth = 0;
    while (end < block.length && (depth > 0 || block[end] !== "\\")) {
      if (block[end] === "(") depth++;
      if (block[end] === ")") depth--;
      end++;
    }
    const raw = block.slice(at + 1, end);
    const match = raw.match(/^(iclip|clip|move|pos|org|fade|fad|1c|3c|1a|3a|fscx|fscy|frz|frx|fry|fax|blur|bord|shad|fsp|fs|fn|an|t|p|alpha)(.*)$/s);
    if (match) tags.push({ name: match[1]!, args: match[2]! });
    at = end;
  }
  return tags;
}

/** The state of an event `relMs` after its own start. */
export function assStateAt(text: string, relMs: number): AssEventState {
  const block = text.match(/^\{(.*?)\}(?=[^{]|$)/s)?.[1] ?? "";
  const state: AssEventState = { x: 0, y: 0, fscx: 100, fscy: 100, frz: 0, frx: 0, fry: 0, fax: 0, blur: 0, c1: "#FFFFFF", c3: "#000000", a1: 0, a3: 0, clip: null, org: null };
  const apply = (tag: { name: string; args: string }, p: number | null) => {
    const { name, args } = tag;
    const arg = args.replace(/^\(|\)$/g, "");
    const target = <T,>(current: T, next: T, blend: (a: T, b: T, p: number) => T): T => (p === null ? next : blend(current, next, p));
    if ((NUMERIC as readonly string[]).includes(name)) {
      const key = name as (typeof NUMERIC)[number];
      state[key] = target(state[key], Number(args), mix);
    } else if (name === "1c") state.c1 = target(state.c1, colourOf(args), mixColour);
    else if (name === "3c") state.c3 = target(state.c3, colourOf(args), mixColour);
    else if (name === "1a") state.a1 = target(state.a1, alphaOf(args), mix);
    else if (name === "3a") state.a3 = target(state.a3, alphaOf(args), mix);
    else if (name === "pos") {
      const [x, y] = arg.split(",").map(Number);
      state.x = x!;
      state.y = y!;
    } else if (name === "move") {
      const [x1, y1, x2, y2, t1, t2] = arg.split(",").map(Number);
      const u = t2 === undefined || t2 === t1 ? (relMs >= (t1 ?? 0) ? 1 : 0) : Math.min(1, Math.max(0, (relMs - t1!) / (t2 - t1!)));
      state.x = mix(x1!, x2!, u);
      state.y = mix(y1!, y2!, u);
    } else if (name === "org") {
      const [x, y] = arg.split(",").map(Number);
      state.org = { x: x!, y: y! };
    } else if (name === "clip" || name === "iclip") {
      const [x1, y1, x2, y2] = arg.split(",").map(Number);
      const next = { x1: x1!, y1: y1!, x2: x2!, y2: y2!, inverse: name === "iclip" };
      state.clip = !state.clip || p === null ? next : { ...next, x1: mix(state.clip.x1, next.x1, p), y1: mix(state.clip.y1, next.y1, p), x2: mix(state.clip.x2, next.x2, p), y2: mix(state.clip.y2, next.y2, p) };
    }
  };
  for (const tag of tagsOf(block)) {
    if (tag.name !== "t") {
      apply(tag, null);
      continue;
    }
    const inner = tag.args.replace(/^\(|\)$/g, "");
    const parts = inner.match(/^(-?\d+),(-?\d+),(.*)$/s);
    if (!parts) continue;
    const [t1, t2] = [Number(parts[1]), Number(parts[2])];
    const p = relMs <= t1 ? 0 : relMs >= t2 ? 1 : (relMs - t1) / (t2 - t1);
    for (const inside of tagsOf(parts[3]!)) apply(inside, p);
  }
  return state;
}

export function assEventTimes(line: string): { startMs: number; endMs: number; layer: number; text: string } | null {
  const match = line.match(/^Dialogue: (\d+),(\d+):(\d+):(\d+)\.(\d+),(\d+):(\d+):(\d+)\.(\d+),[^,]*,,\d+,\d+,\d+,,(.*)$/s);
  if (!match) return null;
  const ms = (h: string, m: string, s: string, cs: string) => ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(cs) * 10;
  return { layer: Number(match[1]), startMs: ms(match[2]!, match[3]!, match[4]!, match[5]!), endMs: ms(match[6]!, match[7]!, match[8]!, match[9]!), text: match[10]! };
}
