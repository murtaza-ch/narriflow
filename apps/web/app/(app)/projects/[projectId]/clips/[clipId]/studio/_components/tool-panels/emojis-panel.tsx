"use client";

import { useMemo } from "react";
import { Box } from "@chakra-ui/react";
import { useStudio } from "../studio-shell";
import { EmojisSection } from "../emoji/emojis-section";
import { useStudioCaptionEmojiEditor } from "../emoji/studio-caption-emojis";
import { ColorField } from "./color-field";
import { PANEL_PX } from "./panel-ui";

/** The Emojis panel: a child of AI tools, opened from its Add emojis row. */
export function EmojisPanel() {
  const editor = useStudioCaptionEmojiEditor();
  const { playbackClock, captionLayers, compositeToBaseEdited, baseEditedToComposite, seekTo } = useStudio(
    "playbackClock",
    "captionLayers",
    "compositeToBaseEdited",
    "baseEditedToComposite",
    "seekTo",
  );
  const live = useMemo(() => ({ clock: playbackClock, layers: captionLayers, toBaseEdited: compositeToBaseEdited }), [playbackClock, captionLayers, compositeToBaseEdited]);
  const timeline = useMemo(
    () => ({ clock: playbackClock, toBaseEdited: compositeToBaseEdited, toComposite: baseEditedToComposite, seek: seekTo }),
    [playbackClock, compositeToBaseEdited, baseEditedToComposite, seekTo],
  );
  return (
    <Box px={PANEL_PX} pt="1" pb="6">
      <EmojisSection editor={editor} live={live} timeline={timeline} ColourField={ColorField} />
    </Box>
  );
}
