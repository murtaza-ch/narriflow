import { notFound } from "next/navigation";
import { CaptionEmojiControlsHarness, type HarnessOptions } from "./controls";

export const metadata = {
  title: "Caption emoji controls",
  robots: { index: false, follow: false },
};

// The Studio's emoji controls (Add Emojis tickets 09, 09b, 16) with local state and a stubbed suggest call,
// no API or sign-in.
//   ?preset=<id>           bold-pop (classic), headline (Dynamic), horizon (Scene)...; default bold-pop.
//   ?rtl=1                 the Urdu script.
//   ?state=<state>         off | none | some | mixed (every other line without an emoji) | nowords | readonly |
//                          hidden (stored emojis that do not draw: a cut word, a cue with a typed emoji); default some.
//   ?script=mixed          the first line in Arabic around "New York" (mixed-direction chips).
//   ?suggest=<answer>      ok (default) | empty | error | offline | hang | partial (half the lines, marked
//                          incomplete) | unsaved (the save before the request cannot finish).
//   ?t=<seconds>           the playhead; default 2.6.
//   ?open=<surface>        live | line | last (the last line's chip) | add: opens the picker from that control after load.
//   ?search=<text>         typed into the open picker.  ?tone=<0-5> preset skin tone.
//   ?run=1                 starts Add with AI / Regenerate after load (answering Replace if it asks).
//   ?mode=light|dark       sets the app's color mode (persisted, as the app's toggle does). The Studio area
//                          stays graphite as the Studio does; the page and portals follow the mode.
//   ?confirm=1             removes one emoji by hand, then presses Regenerate.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const options: HarnessOptions = {
    presetId: params.preset ?? "bold-pop",
    rtl: params.rtl === "1",
    mixedScript: params.script === "mixed",
    state: (params.state as HarnessOptions["state"]) ?? "some",
    suggest: (params.suggest as HarnessOptions["suggest"]) ?? "ok",
    timeSec: Number(params.t ?? 2.6),
    open: (params.open as HarnessOptions["open"]) ?? null,
    search: params.search ?? null,
    tone: params.tone === undefined ? null : Number(params.tone),
    run: params.run === "1",
    confirm: params.confirm === "1",
    mode: params.mode === "light" ? "light" : params.mode === "dark" ? "dark" : null,
  };
  return <CaptionEmojiControlsHarness options={options} />;
}
