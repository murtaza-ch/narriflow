import { notFound } from "next/navigation";
import { SampleBrandFonts, TextLayerSheet, TextLayersPlayground } from "./text-layers";

export const metadata = {
  title: "Text layer harness",
  robots: { index: false, follow: false },
};

// The Studio's Text Layers on fixed samples (title-text tickets 03 and 04), no API or sign-in.
//   ?sheet=vertical|horizontal[&bg=flat|photo]
//     every `TEXT_LAYER_SAMPLES` sample drawn by the real Scene painter from the shared layout, tiled
//     like the export contact sheet (apps/media/scripts/text-layer-sheet.ts: half size, 8 px gaps,
//     7 or 5 columns) so the two PNGs can be laid side by side.
//   (no sheet)[&select=none][&tab=presets|settings]
//     one interactive 9:16 sample: the canvas with the selection frame, grips and floating toolbar,
//     and the Text panel's two tabs with the shared style controls, all on local state.
export default async function Page({ searchParams }: { searchParams: Promise<{ sheet?: string; bg?: string; select?: string; tab?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { sheet, bg, select, tab } = await searchParams;
  if (sheet !== undefined) {
    if (sheet !== "vertical" && sheet !== "horizontal") notFound();
    return (
      <SampleBrandFonts>
        <TextLayerSheet orientation={sheet} background={bg === "photo" ? "photo" : "flat"} />
      </SampleBrandFonts>
    );
  }
  return (
    <SampleBrandFonts>
      <TextLayersPlayground initialSelected={select !== "none"} initialTab={tab === "presets" ? "presets" : "settings"} />
    </SampleBrandFonts>
  );
}
