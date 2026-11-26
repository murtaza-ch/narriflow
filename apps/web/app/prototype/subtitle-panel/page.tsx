import { notFound } from "next/navigation";
import { SubtitlePanelHarness, type SubtitlePanelOptions } from "./harness";

export const metadata = {
  title: "Subtitle panel",
  robots: { index: false, follow: false },
};

// The Studio's transcript panel (Add Emojis ticket 22) over a fixture clip, with local state and a
// fake playhead; no API or sign-in.
//   ?view=sentence|paragraph|word     default sentence.
//   ?emojis=some|two|none|off         some (default): emojis on, a few placed; two: also a caption with two;
//                                     none: emojis on, none placed; off: emojis turned off.
//   ?rtl=1                            the Urdu passage.
//   ?readonly=1                       someone else holds the write lease.
//   ?preset=<id>                      caption style; default bold-pop (headline: Dynamic, reveal: Scene).
//   ?seconds=<n>                      speech to fill (English); default 180.
//   ?t=<seconds>                      the playhead; default 6.  ?play=1 runs it.
//   ?search=<text>                    typed into the search field after load.
//   ?focus=<word>                     focuses the emoji button on that word (shows its remove control).
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const options: SubtitlePanelOptions = {
    view: params.view === "paragraph" || params.view === "word" ? params.view : "sentence",
    emojis: params.emojis === "two" || params.emojis === "none" || params.emojis === "off" ? params.emojis : "some",
    rtl: params.rtl === "1",
    readOnly: params.readonly === "1",
    presetId: params.preset ?? "bold-pop",
    seconds: Number(params.seconds ?? 180),
    timeSec: Number(params.t ?? 6),
    play: params.play === "1",
    search: params.search ?? null,
    focus: params.focus ?? null,
  };
  return <SubtitlePanelHarness options={options} />;
}
