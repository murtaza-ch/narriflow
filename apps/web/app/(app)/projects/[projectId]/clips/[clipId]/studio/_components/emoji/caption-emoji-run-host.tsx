"use client";

import { useStudio } from "../studio-shell";
import { captionEmojiRunBusy, useCaptionEmojiSession } from "./caption-emoji-runs";
import { useStudioCaptionEmojiEditor } from "./studio-caption-emojis";

/**
 * Keeps an emoji editor mounted while the clip's AI run is out, so its answer always has a live
 * source to commit through. The run is started from a panel (the Emojis section, the AI tools
 * panel) that may close before it answers, and the transcript's editor is not mounted in Word view.
 * Mount once, in a part of the Studio that never unmounts.
 */
export function CaptionEmojiRunHost() {
  const { clipInfo } = useStudio("clipInfo");
  const { run } = useCaptionEmojiSession(clipInfo.id);
  return captionEmojiRunBusy(run) ? <RunEditor /> : null;
}

function RunEditor() {
  useStudioCaptionEmojiEditor();
  return null;
}
