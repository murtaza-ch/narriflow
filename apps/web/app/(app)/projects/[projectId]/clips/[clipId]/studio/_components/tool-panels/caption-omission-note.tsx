"use client";

import { Flex, Text } from "@chakra-ui/react";
import { Info } from "lucide-react";
import { type CaptionOmissionNote, editingOmissionSummary } from "@/lib/caption-omissions";
import { PANEL_PX } from "./panel-ui";

/**
 * One quiet line in the caption panel when the caption text holds characters
 * the exported video cannot draw. Absent otherwise. The characters are listed
 * by code point so they can be found in the transcript and replaced.
 */
export function StudioCaptionOmissionNote({ note }: { note: CaptionOmissionNote | null }) {
  if (!note) return null;
  const listed = note.omissions.slice(0, 6).map((omission) => omission.label);
  const more = note.count - listed.length;
  return (
    <Flex role="status" data-caption-omissions mx={PANEL_PX} mb="3" gap="2" align="flex-start" color="studio.fgMuted">
      <Flex flexShrink={0} mt="2px" aria-hidden="true">
        <Info size={14} />
      </Flex>
      <Text fontSize="12px" lineHeight="1.45">
        {editingOmissionSummary(note.count)} Edit the text to replace them: {listed.join(", ")}
        {more > 0 ? ` and ${more} more` : ""}.
      </Text>
    </Flex>
  );
}
