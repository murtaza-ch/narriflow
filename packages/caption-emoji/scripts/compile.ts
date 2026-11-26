/**
 * Compiles one pack SVG into flat, non-zero fill layers on the 64 grid (spec D2). Skia's path ops
 * (CanvasKit) do the geometry: stroke expansion with the source's caps, joins and dashes, the
 * badge clip, and winding normalisation. The output holds only absolute M, L, C and Z.
 */
import CanvasKitInit, { type CanvasKit, type Path } from "canvaskit-wasm";
import {
  CAPTION_EMOJI_DEFAULT_PALETTE,
  CAPTION_EMOJI_INK,
  CAPTION_EMOJI_SKIN_TONES,
  type CaptionEmojiColour,
} from "../src/colour";
import { CAPTION_EMOJI_GRID } from "../src/geometry";
import { dilate, OUTLINE_DECIMALS, stickerOutline } from "./outline";
import { normalise, pathArea, pathData, round, STROKE_PRECISION, transformPath } from "./path-data";
import { IDENTITY, type Matrix, multiply, parseColour, parseSvg, parseTransform, type SvgNode } from "./svg";

export interface CompiledLayer {
  colour: CaptionEmojiColour;
  alpha?: number;
  d: string;
}

export interface CompiledDesign {
  layers: CompiledLayer[];
  /** The union of the layers grown into the sticker backing; the union itself is not shipped. */
  outline: string;
  /** Painted elements in, before merging. */
  sourceLayers: number;
  /** Painted elements dropped because opaque layers above hide them. */
  hiddenLayers: number;
  warnings: string[];
}

/** Intersections smaller than this (grid units squared) do not count as overlap. */
const OVERLAP_AREA = 0.02;
const GRID = CAPTION_EMOJI_GRID;
/**
 * A layer is hidden when, grown by this (grid units) with its holes filled, opaque layers above
 * still cover it.
 */
const HIDDEN_MARGIN = 0.25;
const HIDDEN_AREA = 0.001;
/** Colour layers per design: the renderers cap an emoji at 24 pieces (outline, layers, one spare). */
const MAX_LAYERS = 22;

const SKIN = CAPTION_EMOJI_SKIN_TONES[0]!.hex;
/** The pack redraws these face features on the two dark tones (measured on the variant files). */
const FEATURE = "#302538";
const DARK_EYE = "#180f17";
const DARK_EYE_RIM = "#e4b28d";
const DARK_EYE_RIM_WIDTH = 0.8;
const DARK_LINE = "#f4c39d";

const ROLE_DEFAULTS: Record<string, string> = {
  a: CAPTION_EMOJI_DEFAULT_PALETTE.a,
  b: CAPTION_EMOJI_DEFAULT_PALETTE.b,
  c: CAPTION_EMOJI_DEFAULT_PALETTE.c,
  ink: CAPTION_EMOJI_INK,
};

const INHERITED = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "fill-rule",
  "fill-opacity",
  "stroke-opacity",
] as const;
type Style = Partial<Record<(typeof INHERITED)[number], string>>;

export async function loadCanvasKit(): Promise<CanvasKit> {
  return CanvasKitInit();
}

interface WorkLayer {
  colour: CaptionEmojiColour;
  key: string;
  alpha: number;
  path: Path;
}

export function compileDesign(ck: CanvasKit, source: string, options: { hasTones: boolean }): CompiledDesign {
  const owned: Path[] = [];
  const own = (path: Path | null | undefined, what: string): Path => {
    if (!path) throw new Error(`geometry failed: ${what}`);
    owned.push(path);
    return path;
  };
  const warnings: string[] = [];
  try {
    const svg = parseSvg(source);
    const clipDefs = new Map<string, SvgNode>();
    const collect = (node: SvgNode) => {
      if (node.tag === "clipPath") {
        if (!node.attrs.id) throw new Error("clipPath without id");
        clipDefs.set(node.attrs.id, node);
      }
      node.children.forEach(collect);
    };
    collect(svg);

    const grid = own(new ck.PathBuilder().addRect(ck.LTRBRect(0, 0, GRID, GRID)).detach(), "grid");
    const raw: WorkLayer[] = [];

    const localShape = (node: SvgNode): Path => {
      const a = node.attrs;
      const num = (name: string, fallback?: number): number => {
        const value = a[name] === undefined ? fallback : Number(a[name]);
        if (value === undefined || !Number.isFinite(value)) throw new Error(`<${node.tag}> bad ${name}`);
        return value;
      };
      switch (node.tag) {
        case "path":
          return own(ck.Path.MakeFromSVGString(a.d ?? ""), `path d ${a.d}`);
        case "circle": {
          const [cx, cy, r] = [num("cx", 0), num("cy", 0), num("r")];
          return own(new ck.PathBuilder().addOval(ck.LTRBRect(cx - r, cy - r, cx + r, cy + r), false, 1).detach(), "circle");
        }
        case "ellipse": {
          const [cx, cy, rx, ry] = [num("cx", 0), num("cy", 0), num("rx"), num("ry")];
          return own(new ck.PathBuilder().addOval(ck.LTRBRect(cx - rx, cy - ry, cx + rx, cy + ry), false, 1).detach(), "ellipse");
        }
        case "rect": {
          const [x, y, w, h] = [num("x", 0), num("y", 0), num("width"), num("height")];
          let rx = a.rx === undefined ? undefined : num("rx");
          let ry = a.ry === undefined ? undefined : num("ry");
          rx = Math.min(rx ?? ry ?? 0, w / 2);
          ry = Math.min(ry ?? rx, h / 2);
          const rect = ck.XYWHRect(x, y, w, h);
          const builder = new ck.PathBuilder();
          if (rx > 0 && ry > 0) builder.addRRect(ck.RRectXY(rect, rx, ry));
          else builder.addRect(rect);
          return own(builder.detach(), "rect");
        }
        default:
          throw new Error(`<${node.tag}> is not a shape`);
      }
    };

    const place = (path: Path, m: Matrix, clip: Path | null): Path | null => {
      let out = own(transformPath(ck, path, m), "transform");
      if (clip) out = own(ck.Path.MakeFromOp(out, clip, ck.PathOp.Intersect), "clip");
      const [l, t, r, b] = out.computeTightBounds();
      if (l! < 0 || t! < 0 || r! > GRID || b! > GRID) out = own(ck.Path.MakeFromOp(out, grid, ck.PathOp.Intersect), "grid clip");
      out = own(normalise(ck, out), "normalise");
      return out.isEmpty() ? null : out;
    };

    const colourOf = (
      node: SvgNode,
      paint: "fill" | "stroke",
      hex: string,
    ): { colour: CaptionEmojiColour; rim?: boolean } => {
      const a = node.attrs;
      let role = paint === "fill" ? a["data-role"] : a["data-stroke-role"];
      if (paint === "stroke" && role === undefined && a.fill === "none") role = a["data-role"];
      if (role !== undefined) {
        const name = role === "line" ? "ink" : role;
        if (!(name in ROLE_DEFAULTS)) throw new Error(`unknown role ${role}`);
        if (ROLE_DEFAULTS[name] !== hex) warnings.push(`${paint} role ${role} on ${hex}`);
        return { colour: { role: name as "a" | "b" | "c" | "ink" } };
      }
      if (options.hasTones) {
        if (hex === SKIN) return { colour: { role: "skin" } };
        if (hex === FEATURE && paint === "fill" && node.tag === "ellipse" && !a.stroke) {
          return { colour: { tone: [FEATURE, FEATURE, FEATURE, FEATURE, DARK_EYE, DARK_EYE] }, rim: true };
        }
        if (hex === FEATURE && paint === "stroke" && node.tag === "path") {
          return { colour: { tone: [FEATURE, FEATURE, FEATURE, FEATURE, DARK_LINE, DARK_LINE] } };
        }
      }
      if (hex === CAPTION_EMOJI_INK) return { colour: { role: "ink" } };
      return { colour: { hex } };
    };

    const push = (colour: CaptionEmojiColour, alpha: number, path: Path | null) => {
      if (path) raw.push({ colour, key: JSON.stringify(colour), alpha, path });
    };

    const walk = (node: SvgNode, parentMatrix: Matrix, parentClip: Path | null, parentStyle: Style) => {
      if (node.tag === "clipPath" || node.tag === "title") return;
      const attrs: Record<string, string> = { ...node.attrs };
      if (attrs.style) {
        for (const declaration of attrs.style.split(";")) {
          const [key, value] = declaration.split(":").map((part) => part.trim());
          if (key && value !== undefined) attrs[key] = value;
        }
      }
      const style: Style = { ...parentStyle };
      for (const key of INHERITED) if (attrs[key] !== undefined) style[key] = attrs[key];
      const m = multiply(parentMatrix, parseTransform(attrs.transform));
      let clip = parentClip;
      if (attrs["clip-path"]) {
        const id = /^url\(#([^)]+)\)$/.exec(attrs["clip-path"])?.[1];
        const def = id ? clipDefs.get(id) : undefined;
        if (!def) throw new Error(`unknown clip ${attrs["clip-path"]}`);
        let shape: Path | null = null;
        for (const child of def.children) {
          const piece = own(transformPath(ck, localShape(child), multiply(m, parseTransform(child.attrs.transform))), "clip shape");
          shape = shape ? own(ck.Path.MakeFromOp(shape, piece, ck.PathOp.Union), "clip union") : piece;
        }
        if (!shape) throw new Error("empty clipPath");
        clip = clip ? own(ck.Path.MakeFromOp(clip, shape, ck.PathOp.Intersect), "clip nest") : shape;
      }
      if (node.tag === "svg" || node.tag === "g") {
        if (attrs.opacity !== undefined && Number(attrs.opacity) !== 1) throw new Error("group opacity is not supported");
        for (const child of node.children) walk(child, m, clip, style);
        return;
      }
      const local = localShape({ ...node, attrs });
      const opacity = attrs.opacity === undefined ? 1 : Number(attrs.opacity);
      const fill = parseColour(style.fill ?? "#000000");
      const stroke = style.stroke === undefined ? null : parseColour(style.stroke);
      const strokeWidth = Number(style["stroke-width"] ?? 1);
      const strokes = stroke !== null && strokeWidth > 0;
      if (opacity < 1 && fill && strokes) warnings.push("opacity on an element with fill and stroke");

      if (fill) {
        let shape = local;
        if (style["fill-rule"] === "evenodd") {
          shape = own(local.copy(), "copy");
          shape.setFillType(ck.FillType.EvenOdd);
        }
        const { colour, rim } = colourOf(node, "fill", fill);
        push(colour, opacity * Number(style["fill-opacity"] ?? 1), place(shape, m, clip));
        if (rim) {
          const rimPath = own(local.makeStroked({ width: DARK_EYE_RIM_WIDTH, precision: STROKE_PRECISION }), "rim");
          push({ tone: [null, null, null, null, DARK_EYE_RIM, DARK_EYE_RIM] }, opacity, place(rimPath, m, clip));
        }
      }
      if (strokes) {
        let line = local;
        const dashes = style["stroke-dasharray"];
        if (dashes && dashes !== "none") {
          const parts = dashes.split(/[\s,]+/).filter(Boolean).map(Number);
          if (parts.length !== 2 || parts.some((part) => !(part >= 0))) throw new Error(`unsupported dasharray ${dashes}`);
          // Skia measures length coarsely at grid scale (2.5 degrees of drift round a circle), so
          // dash a 16x copy and scale it back.
          const up = own(transformPath(ck, local, [16, 0, 0, 16, 0, 0]), "dash scale");
          const dashed = own(up.makeDashed(parts[0]! * 16, parts[1]! * 16, Number(style["stroke-dashoffset"] ?? 0) * 16), "dash");
          line = own(transformPath(ck, dashed, [1 / 16, 0, 0, 1 / 16, 0, 0]), "dash unscale");
        }
        const cap = style["stroke-linecap"] ?? "butt";
        const join = style["stroke-linejoin"] ?? "miter";
        const outline = own(
          line.makeStroked({
            width: strokeWidth,
            cap: cap === "round" ? ck.StrokeCap.Round : cap === "square" ? ck.StrokeCap.Square : ck.StrokeCap.Butt,
            join: join === "round" ? ck.StrokeJoin.Round : join === "bevel" ? ck.StrokeJoin.Bevel : ck.StrokeJoin.Miter,
            miter_limit: Number(style["stroke-miterlimit"] ?? 4),
            precision: STROKE_PRECISION,
          }),
          "stroke",
        );
        const { colour } = colourOf(node, "stroke", stroke);
        push(colour, opacity * Number(style["stroke-opacity"] ?? 1), place(outline, m, clip));
      }
    };
    walk(svg, IDENTITY, null, {});

    const overlaps = (x: Path, y: Path) => {
      const shared = ck.Path.MakeFromOp(x, y, ck.PathOp.Intersect);
      if (!shared) return true;
      owned.push(shared);
      return pathArea(ck, shared) > OVERLAP_AREA;
    };

    // Drop layers that opaque layers above hide completely, with a margin so no anti-aliased edge
    // of the hidden layer showed (the astronauts draw a whole face under the helmet).
    const visible: WorkLayer[] = [];
    let cover: Path | null = null;
    for (let i = raw.length - 1; i >= 0; i -= 1) {
      const layer = raw[i]!;
      if (cover) {
        const grown = own(dilate(ck, layer.path, HIDDEN_MARGIN), "hidden margin");
        const shown = ck.Path.MakeFromOp(grown, cover, ck.PathOp.Difference);
        if (shown) owned.push(shown);
        if (shown && (shown.isEmpty() || pathArea(ck, shown) < HIDDEN_AREA)) continue;
      }
      visible.unshift(layer);
      if (isCover(layer)) cover = cover ? own(ck.Path.MakeFromOp(cover, layer.path, ck.PathOp.Union), "cover") : layer.path;
    }

    // Unite two layers of one colour and alpha when either can move to the other's place in
    // painter order without passing over a layer it overlaps. Translucent layers unite only when
    // they do not overlap each other. Repeats until nothing more unites.
    const merged: WorkLayer[] = visible.map((layer) => ({ ...layer }));
    const unite = (x: Path, y: Path) => own(normalise(ck, own(ck.Path.MakeFromOp(x, y, ck.PathOp.Union), "merge")), "merge normalise");
    for (let changed = true; changed; ) {
      changed = false;
      search: for (let j = 1; j < merged.length; j += 1) {
        const upper = merged[j]!;
        for (let i = j - 1; i >= 0; i -= 1) {
          const lower = merged[i]!;
          if (lower.key !== upper.key || lower.alpha !== upper.alpha) continue;
          if (upper.alpha < 1 && overlaps(lower.path, upper.path)) continue;
          const between = merged.slice(i + 1, j);
          if (between.every((layer) => !overlaps(layer.path, upper.path))) {
            lower.path = unite(lower.path, upper.path);
            merged.splice(j, 1);
          } else if (between.every((layer) => !overlaps(layer.path, lower.path))) {
            upper.path = unite(lower.path, upper.path);
            merged.splice(i, 1);
          } else {
            continue;
          }
          changed = true;
          break search;
        }
      }
    }
    if (merged.length > MAX_LAYERS) throw new Error(`${merged.length} colour layers (cap ${MAX_LAYERS})`);

    let silhouette: Path | null = null;
    for (const layer of merged) {
      silhouette = silhouette ? own(ck.Path.MakeFromOp(silhouette, layer.path, ck.PathOp.Union), "silhouette") : layer.path;
    }
    if (!silhouette) throw new Error("design draws nothing");
    silhouette = own(normalise(ck, silhouette), "silhouette normalise");
    const outline = own(stickerOutline(ck, silhouette), "outline");

    const layers = merged
      .map((layer): CompiledLayer => {
        const d = pathData(ck, layer.path);
        return layer.alpha < 1 ? { colour: layer.colour, alpha: round(layer.alpha), d } : { colour: layer.colour, d };
      })
      .filter((layer) => layer.d !== "");
    return { layers, outline: pathData(ck, outline, OUTLINE_DECIMALS), sourceLayers: raw.length, hiddenLayers: raw.length - visible.length, warnings };
  } finally {
    for (const path of new Set(owned)) path.delete();
  }
}

/** Opaque and drawn at every tone, so it hides whatever is under it. */
function isCover(layer: WorkLayer): boolean {
  return layer.alpha >= 1 && !("tone" in layer.colour && layer.colour.tone.includes(null));
}
