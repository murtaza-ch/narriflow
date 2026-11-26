import { notFound } from "next/navigation";
import { CaptionEmojisHarness } from "./caption-emojis";
import { EMOJI_FRAMES, emojiFrameId } from "./frames";

export const metadata = {
  title: "Caption emoji harness",
  robots: { index: false, follow: false },
};

// The Studio's emoji layer over fixed cues (Add Emojis ticket 07), no API or sign-in.
//   ?t=<seconds>                 every frame at one time; a scrubber and Play move it.
//   ?only=<preset>[-rtl]         one frame alone (screenshots), at `scale` (default 0.5).
//   ?pop=<n>[&offset=<ms>]       every frame at its own n-th emoji's anchor word plus `offset`
//                                (90: the middle of the 180 ms pop; 450: at rest).
//   ?debug=1                     each frame's cue boxes and placed emojis as JSON (`data-emoji-debug`).
//   ?ids=<id>,<id>               emoji ids that replace the hand-chosen ones in turn, on the same words.
export default async function Page({ searchParams }: { searchParams: Promise<{ t?: string; only?: string; scale?: string; pop?: string; offset?: string; debug?: string; ids?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { t, only, scale, pop, offset, debug, ids } = await searchParams;
  const spec = only === undefined ? null : (EMOJI_FRAMES.find((frame) => emojiFrameId(frame) === only) ?? null);
  if (only !== undefined && !spec) notFound();
  return (
    <CaptionEmojisHarness
      timeSec={Number(t ?? 1.3)}
      only={spec}
      scale={Number(scale ?? (spec ? 0.5 : 0.25))}
      pop={pop === undefined ? null : { index: Number(pop), offsetMs: Number(offset ?? 90) }}
      debug={debug === "1"}
      ids={ids ? ids.split(",") : null}
    />
  );
}
