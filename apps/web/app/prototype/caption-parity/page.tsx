import { notFound } from "next/navigation";
import manifest from "../../../../../packages/composition-plan/src/__fixtures__/dynamic-captions/manifest.json";
import { CaptionParity, DynamicCaptionParity, type DynamicCaptionCase } from "./caption-parity";

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
//   ?preset=<preset id>&t=<seconds>
//     the classic engine on a fixed script (the original harness).
/** The worker frames' pinned backgrounds (`caption-frames.ts`) are these Studio preset backdrops. */
const FIXTURE_BACKDROPS: Record<string, string> = { dark: "dark-studio", bright: "bright-room", busy: "brick-street" };
const parityBackdrop = (bg: string | undefined) => FIXTURE_BACKDROPS[bg ?? ""] ?? "green-studio";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string; case?: string; t?: string; scale?: string; play?: string; bg?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { preset = "bold-pop", case: caseId, t, scale, play, bg } = await searchParams;
  if (caseId !== undefined) {
    const fixture = (manifest.cases as unknown as readonly DynamicCaptionCase[]).find((entry) => entry.id === caseId);
    if (!fixture) notFound();
    return <DynamicCaptionParity fixture={fixture} time={Number(t ?? fixture.words.at(-1)!.endSec - 0.05)} scale={Number(scale ?? 1)} play={play !== undefined} backdrop={parityBackdrop(bg)} />;
  }
  return <CaptionParity presetId={preset} time={Number(t ?? "1.1")} />;
}
