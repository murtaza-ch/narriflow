/**
 * A reader for the emoji pack's SVG subset: one root `<svg>`, `<g>`, `<path>`, `<circle>`,
 * `<ellipse>`, `<rect>`, `<clipPath>` and `<title>`, attributes in double quotes. Anything else
 * is an error, so a new construct in the pack fails the build instead of drawing wrong.
 */

export interface SvgNode {
  tag: string;
  attrs: Record<string, string>;
  children: SvgNode[];
}

const KNOWN_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "clipPath", "title"]);

export function parseSvg(source: string): SvgNode {
  const root: SvgNode = { tag: "#root", attrs: {}, children: [] };
  const stack: SvgNode[] = [root];
  const tagPattern = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
  let cursor = 0;
  for (let match = tagPattern.exec(source); match; match = tagPattern.exec(source)) {
    const between = source.slice(cursor, match.index);
    const parent = stack[stack.length - 1]!;
    if (between.trim() !== "" && parent.tag !== "title") throw new Error(`unexpected text ${JSON.stringify(between.slice(0, 40))}`);
    cursor = tagPattern.lastIndex;
    const [, closing, tag, rawAttrs, selfClosing] = match;
    if (!KNOWN_TAGS.has(tag!)) throw new Error(`unsupported element <${tag}>`);
    if (closing) {
      const open = stack.pop();
      if (!open || open.tag !== tag) throw new Error(`mismatched </${tag}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of rawAttrs!.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[attr[1]!] = attr[2]!;
    const node: SvgNode = { tag: tag!, attrs, children: [] };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error("unclosed element");
  if (source.slice(cursor).trim() !== "") throw new Error("trailing text");
  const svg = root.children[0];
  if (root.children.length !== 1 || svg?.tag !== "svg") throw new Error("expected one <svg> root");
  if (svg.attrs.viewBox !== "0 0 64 64") throw new Error(`unexpected viewBox ${svg.attrs.viewBox}`);
  return svg;
}

/** Affine matrix `[a, b, c, d, e, f]`: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function parseTransform(value: string | undefined): Matrix {
  let matrix = IDENTITY;
  if (!value) return matrix;
  const pattern = /(\w+)\s*\(([^)]*)\)/g;
  let consumed = "";
  for (const match of value.matchAll(pattern)) {
    consumed += match[0];
    const name = match[1]!;
    const args = match[2]!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (args.some((arg) => !Number.isFinite(arg))) throw new Error(`bad transform ${value}`);
    let step: Matrix;
    if (name === "translate" && (args.length === 1 || args.length === 2)) {
      step = [1, 0, 0, 1, args[0]!, args[1] ?? 0];
    } else if (name === "scale" && (args.length === 1 || args.length === 2)) {
      step = [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0];
    } else if (name === "rotate" && (args.length === 1 || args.length === 3)) {
      const angle = (args[0]! * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const cx = args[1] ?? 0;
      const cy = args[2] ?? 0;
      step = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
    } else if (name === "matrix" && args.length === 6) {
      step = args as unknown as Matrix;
    } else {
      throw new Error(`unsupported transform ${match[0]}`);
    }
    matrix = multiply(matrix, step);
  }
  if (consumed.replace(/\s/g, "") !== value.replace(/\s/g, "")) throw new Error(`unparsed transform ${value}`);
  return matrix;
}

/** `#rgb` / `#rrggbb` / `white` / `black` to lowercase `#rrggbb`; `none` to null. */
export function parseColour(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (v === "none") return null;
  if (v === "white") return "#ffffff";
  if (v === "black") return "#000000";
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  throw new Error(`unsupported colour ${value}`);
}
