/*
 * Paints the scene display list (scene.ts) with Canvas 2D. Works with the
 * browser canvas and with Skia in Node, as long as `Path2D` is global.
 */
import type { Op, Paint } from "./scene";

type Ctx = CanvasRenderingContext2D;

const paths = new Map<string, Path2D>();
const path = (d: string) => {
  let p = paths.get(d);
  if (!p) {
    p = new globalThis.Path2D(d);
    if (paths.size > 4000) paths.clear();
    paths.set(d, p);
  }
  return p;
};

function paint(ctx: Ctx, p: Paint) {
  if (typeof p === "string") return p;
  const g =
    p.kind === "linear"
      ? ctx.createLinearGradient(p.x0, p.y0, p.x1, p.y1)
      : ctx.createRadialGradient(p.cx, p.cy, 0, p.cx, p.cy, p.r);
  for (const [o, c] of p.stops) g.addColorStop(o, c);
  return g;
}

export function drawOps(ctx: Ctx, ops: Op[]) {
  for (const op of ops) {
    ctx.save();
    if (op.alpha !== undefined) ctx.globalAlpha *= op.alpha;
    if (op.blend === "screen") ctx.globalCompositeOperation = "screen";
    switch (op.t) {
      case "group":
        ctx.translate(op.x ?? 0, op.y ?? 0);
        if (op.rot) ctx.rotate((op.rot * Math.PI) / 180);
        if (op.sx !== undefined || op.sy !== undefined) ctx.scale(op.sx ?? 1, op.sy ?? 1);
        drawOps(ctx, op.children);
        break;
      case "rect":
        ctx.fillStyle = paint(ctx, op.fill);
        ctx.beginPath();
        if (op.r) ctx.roundRect(op.x, op.y, op.w, op.h, op.r);
        else ctx.rect(op.x, op.y, op.w, op.h);
        ctx.fill();
        break;
      case "ellipse":
        ctx.beginPath();
        ctx.ellipse(op.cx, op.cy, op.rx, op.ry, 0, 0, Math.PI * 2);
        if (op.fill) {
          ctx.fillStyle = paint(ctx, op.fill);
          ctx.fill();
        }
        if (op.stroke) {
          ctx.strokeStyle = paint(ctx, op.stroke);
          ctx.lineWidth = op.lw ?? 1;
          ctx.stroke();
        }
        break;
      case "path": {
        const p = path(op.d);
        if (op.fill) {
          ctx.fillStyle = paint(ctx, op.fill);
          ctx.fill(p);
        }
        if (op.stroke) {
          ctx.strokeStyle = paint(ctx, op.stroke);
          ctx.lineWidth = op.lw ?? 1;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.stroke(p);
        }
        break;
      }
    }
    ctx.restore();
  }
}
