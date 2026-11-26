import { notFound } from "next/navigation";
import { CAPTION_PRESETS } from "@narriflow/validators";
import { CardFrame } from "./card-frame";

export const metadata = {
  title: "Caption card renderer",
  robots: { index: false, follow: false },
};

// One caption preset card's sample, drawn by the real painters and stepped frame by frame from
// `window.__card.set(seconds)`, for `apps/web/scripts/caption-cards/render.ts` to record.
//   ?card=<preset id>[&w=<css px width>]
export default async function Page({ searchParams }: { searchParams: Promise<{ card?: string; w?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { card, w } = await searchParams;
  const named = CAPTION_PRESETS.find((preset) => preset.id === card);
  if (!named) notFound();
  return <CardFrame presetId={named.id} width={Number(w) || 200} />;
}
