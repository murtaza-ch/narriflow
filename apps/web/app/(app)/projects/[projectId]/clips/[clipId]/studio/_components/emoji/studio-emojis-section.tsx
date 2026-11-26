"use client";

import { useMemo } from "react";
import { Box } from "@chakra-ui/react";
import { useStudio } from "../studio-shell";
import { PANEL_PX } from "../tool-panels/panel-ui";
import { EmojisSection } from "./emojis-section";
import type { EmojiColourField } from "./emoji-style-controls";
import { useStudioCaptionEmojiEditor } from "./studio-caption-emojis";

/** The Emojis section in the Captions panel's Customize tab, for every preset kind. */
export function StudioEmojisSection({ ColorField }: { ColorField: EmojiColourField }) {
  const editor = useStudioCaptionEmojiEditor();
  const { playbackClock, captionLayers, compositeToBaseEdited } = useStudio("playbackClock", "captionLayers", "compositeToBaseEdited");
  const live = useMemo(() => ({ clock: playbackClock, layers: captionLayers, toBaseEdited: compositeToBaseEdited }), [playbackClock, captionLayers, compositeToBaseEdited]);
  return (
    <Box px={PANEL_PX} pt="6" pb="2">
      <EmojisSection editor={editor} live={live} ColourField={ColorField} />
    </Box>
  );
}
