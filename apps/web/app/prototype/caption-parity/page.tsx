import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { notFound } from "next/navigation";
import manifest from "../../../../../packages/composition-plan/src/__fixtures__/dynamic-captions/manifest.json";
import { CAPTION_SCENE_NAMES, type CaptionSceneName } from "@narriflow/validators";
import { CaptionParity, DynamicCaptionParity, RealSceneParity, SceneParity, SheetParity, type DynamicCaptionCase } from "./caption-parity";
import { SCENE_EDGE_DEMOS, type SceneEdgeDemo } from "@narriflow/caption-scene";

export const metadata = {
  title: "Caption parity harness",
  robots: { index: false, follow: false },
};

// Renders the studio caption painters at export scale, to screenshot beside
// the worker's libass frames (spec section 9, "Studio frames").
//   ?case=<fixture id>&t=<seconds>[&scale=<display px per canvas px>][&bg=dark|bright|busy][&play]
//     a Dynamic Style case from packages/composition-plan/src/__fixtures__/dynamic-captions,
//     through the real composition plan and block painter, on a 1080x1920 canvas, over the
//     worker frames' background (`bg`; green-studio when absent).
//     `play` loops the playhead from 0 to just past the cue instead (per-frame cost checks).
//   ?scene=<scene id>&t=<ms>[&bg=dark|bright|busy|flat][&scale=][&edge=<edge demo>][&size=WxH]
//     a Scene Style's sample script (or an edge demo) built by its program and drawn by the scene
//     painter, frozen `t` ms into the loop on a canvas (1080x1920 by default). `flat` is the plain
//     grey the diff tools compare on.
//   ?real=<clip dir>&preset=<scene id>&t=<ms>[&bg=flat|frame][&scale=]
//     a REAL clip (dev only; private files read from .scratch/motion-captions/out/real/<clip dir>/): its
//     document.json with the preset swapped, planned and drawn by the real scene painter at `t` ms of output
//     time. `bg=frame` paints over renders/bg/<t>.png (the clip's frame rendered without captions), else flat grey.
//   ?sheet=1&t=<ms>
//     the primitives sheet (`primitivesSheet`) on a 1080x2400 canvas, over flat grey.
//   ?preset=<preset id>&t=<seconds>
//     the classic engine on a fixed script (the original harness).
/** The worker frames' pinned backgrounds (`caption-frames.ts`) are these Studio preset backdrops. */
const FIXTURE_BACKDROPS: Record<string, string> = { dark: "dark-studio", bright: "bright-room", busy: "brick-street" };
const parityBackdrop = (bg: string | undefined) => FIXTURE_BACKDROPS[bg ?? ""] ?? "green-studio";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ real?: string; preset?: string; case?: string; scene?: string; sheet?: string; edge?: string; size?: string; t?: string; scale?: string; play?: string; bg?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { real, preset = "bold-pop", case: caseId, scene, sheet, edge, size, t, scale, play, bg } = await searchParams;
  if (real !== undefined) {
    if (!/^[A-Za-z0-9_-]+$/.test(real)) notFound();
    const dir = join(resolve(process.cwd(), "../.."), ".scratch/motion-captions/out/real", real);
    if (!existsSync(join(dir, "document.json"))) notFound();
    const frame = join(dir, "renders", "bg", `${Math.round(Number(t ?? 0))}.png`);
    const backdropUrl = bg === "frame" && existsSync(frame) ? `data:image/png;base64,${readFileSync(frame).toString("base64")}` : null;
    return <RealSceneParity document={JSON.parse(readFileSync(join(dir, "document.json"), "utf8"))} presetId={preset} timeMs={Number(t ?? 0)} scale={Number(scale ?? 1)} backdropUrl={backdropUrl} />;
  }
  if (sheet !== undefined) return <SheetParity timeMs={Number(t ?? 0)} />;
  if (scene !== undefined) {
    if (!(CAPTION_SCENE_NAMES as readonly string[]).includes(scene)) notFound();
    if (edge !== undefined && !(SCENE_EDGE_DEMOS as readonly string[]).includes(edge)) notFound();
    const [width, height] = (size ?? "1080x1920").split("x").map(Number);
    return (
      <SceneParity
        scene={scene as CaptionSceneName}
        timeMs={Number(t ?? 0)}
        scale={Number(scale ?? 1)}
        bg={bg ?? "dark"}
        {...(edge ? { edge: edge as SceneEdgeDemo } : {})}
        size={{ width: width || 1080, height: height || 1920 }}
      />
    );
  }
  if (caseId !== undefined) {
    const fixture = (manifest.cases as unknown as readonly DynamicCaptionCase[]).find((entry) => entry.id === caseId);
    if (!fixture) notFound();
    return <DynamicCaptionParity fixture={fixture} time={Number(t ?? fixture.words.at(-1)!.endSec - 0.05)} scale={Number(scale ?? 1)} play={play !== undefined} backdrop={parityBackdrop(bg)} />;
  }
  return <CaptionParity presetId={preset} time={Number(t ?? "1.1")} />;
}
