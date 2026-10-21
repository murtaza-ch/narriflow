import type { Metadata } from "next";
import { CAPTION_PRESETS, MONTHLY_PROCESSING_MINUTE_LIMITS } from "@narriflow/validators";
import { Brand } from "./_components/brand";
import { CaptionLab } from "./_components/caption-lab";
import { buildCaptionStyles, type CaptionStyle } from "./_components/caption-styles";
import { Closing, Footer } from "./_components/closing";
import { Faq } from "./_components/faq";
import { Features } from "./_components/features";
import { landingSerif } from "./_components/fonts";
import { HowItWorks } from "./_components/how";
import { Intro } from "./_components/intro";
import { CLIPS, DEMOS, LAB_PRESET_IDS } from "./_components/landing-data";
import { LandingShell } from "./_components/landing-shell";
import { Nav } from "./_components/nav";
import { Pricing } from "./_components/pricing";
import { Rank } from "./_components/rank";
import { ClipWall } from "./_components/wall";
import "./_components/landing.css";
import "./_components/closing-variants.css";

export const metadata: Metadata = {
  title: { absolute: "Narriflow · Turn long videos into short clips" },
  description:
    "Narriflow finds the best moments in your podcast, webinar or stream, frames them vertical, captions every word and schedules them to six platforms.",
};

/** The styles a section needs, plus Bold Pop as its fallback. */
function pick(styles: Record<string, CaptionStyle>, ids: readonly string[]) {
  const subset: Record<string, CaptionStyle> = {};
  for (const id of ["bold-pop", ...ids]) {
    const style = styles[id];
    if (style) subset[id] = style;
  }
  return subset;
}

export default function HomePage() {
  const styles = buildCaptionStyles();
  const freeMinutes = MONTHLY_PROCESSING_MINUTE_LIMITS.free;
  const clipStyles = pick(styles, CLIPS.map((clip) => clip.presetId));
  const introStyles = pick(styles, [
    ...CLIPS.map((clip) => clip.presetId),
    ...DEMOS.flatMap((demo) => demo.cuts.map((cut) => cut.presetId)),
  ]);
  const labPresets = LAB_PRESET_IDS.flatMap((id) => styles[id] ?? []);

  return (
    <LandingShell className={`lx ${landingSerif.variable}`}>
      <Nav />
      <main>
        <Intro styles={introStyles} freeMinutes={freeMinutes} />
        <ClipWall styles={clipStyles} />
        <HowItWorks styles={pick(styles, [])} />
        <Rank />
        <Brand presets={labPresets} />
        <CaptionLab presets={labPresets} presetCount={CAPTION_PRESETS.length} />
        <Features />
        <Pricing />
        <Faq />
        <Closing styles={introStyles} freeMinutes={freeMinutes} />
      </main>
      <Footer freeMinutes={freeMinutes} />
    </LandingShell>
  );
}
