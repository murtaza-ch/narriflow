"use client";

import { Dialog, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { HardDriveDownload } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";

/** What each editor-document area is called on screen; the most specific prefix wins. */
const AREA_LABELS: readonly [prefix: string, label: string][] = [
  ["studioEdits.textLayers", "Text overlays"],
  ["studioEdits.transition", "Transition"],
  ["studioEdits.music", "Music"],
  ["studioEdits.sourceAudio", "Original audio"],
  ["studioEdits.logo", "Logo"],
  ["studioEdits.background", "Background"],
  ["studioEdits.framing", "Framing"],
  ["studioEdits.speakerLayoutOverrides", "Layout"],
  ["studioEdits.sceneLayouts", "Layout"],
  ["studioEdits.sfx", "Sound effects"],
  ["studioEdits.visualBroll", "B-roll"],
  ["captionPreset", "Caption style"],
  ["transcriptSlice", "Transcript"],
  ["deletedRanges", "Cuts"],
  ["sceneBlocks", "Scenes"],
  ["censorSegments", "Censored words"],
  ["mediaMotions", "Motion"],
  ["brollUrl", "B-roll"],
  ["clipStartSec", "Trim"],
  ["clipEndSec", "Trim"],
];

/** The changed areas by name, once each: "captionPreset.fontSize" reads as "Caption style". */
function conflictAreas(paths: string[]): string[] {
  const labels = paths.map((path) => {
    const hit = AREA_LABELS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`));
    return hit?.[1] ?? "Other edits";
  });
  return [...new Set(labels)];
}

const actionProps = {
  h: "40px",
  px: "4",
  borderRadius: "10px",
  fontSize: "14px",
  fontWeight: "500",
} as const;

/**
 * Shown when the draft saved on this device overlaps newer cloud edits. A
 * choice, not a warning: the two versions get equal weight, with the draft
 * the primary action. Renders in a portal, so studio tokens only; it can't be
 * dismissed without choosing.
 */
export function DraftRecoveryDialog({
  open,
  conflictPaths,
  onKeepCloud,
  onRecoverLocal,
}: {
  open: boolean;
  conflictPaths: string[];
  onKeepCloud: () => void;
  onRecoverLocal: () => void;
}) {
  const areas = conflictAreas(conflictPaths);
  return (
    <Dialog.Root open={open} closeOnEscape={false} closeOnInteractOutside={false} placement="center">
      <Portal>
        <Dialog.Backdrop zIndex={400} />
        <Dialog.Positioner zIndex={410}>
          <Dialog.Content
            w="min(460px, 92vw)"
            maxW="min(460px, 92vw)"
            bg="studio.surface"
            color="studio.fg"
            borderRadius="14px"
            p="6"
          >
            <Flex boxSize="40px" mb="4" align="center" justify="center" borderRadius="full" bg="studio.raised" color="studio.accent" aria-hidden>
              <HardDriveDownload size={18} />
            </Flex>
            <Stack gap="2">
              <Dialog.Title asChild>
                <Text fontSize="17px" fontWeight="500" letterSpacing="-0.01em" color="studio.fg">
                  A recovered draft overlaps newer cloud edits
                </Text>
              </Dialog.Title>
              <Dialog.Description asChild>
                <Text fontSize="14px" color="studio.fgMuted" lineHeight="1.6">
                  Narriflow kept the draft on this device, but both copies changed the same
                  {areas.length === 1 ? " area" : " areas"}. Choose which version should
                  become the editable copy. The recovered draft stays stored until you decide.
                </Text>
              </Dialog.Description>
            </Stack>
            {areas.length > 0 ? (
              <Flex mt="4" gap="1.5" wrap="wrap" aria-label="Changed in both copies">
                {areas.slice(0, 4).map((area) => (
                  <Text
                    key={area}
                    px="2"
                    py="0.5"
                    borderRadius="6px"
                    bg="studio.subtle"
                    fontSize="12px"
                    color="studio.fgMuted"
                  >
                    {area}
                  </Text>
                ))}
                {areas.length > 4 ? (
                  <Text px="1" py="0.5" fontSize="12px" color="studio.fgSubtle">
                    +{areas.length - 4} more
                  </Text>
                ) : null}
              </Flex>
            ) : null}
            <Flex justify="flex-end" gap="2" mt="6" wrap="wrap">
              <Button
                {...actionProps}
                bg="studio.raised"
                color="studio.fg"
                _hover={{ bg: "studio.borderStrong" }}
                onClick={onKeepCloud}
              >
                Keep cloud version
              </Button>
              <Button
                {...actionProps}
                bg="studio.fg"
                color="studio.canvas"
                _hover={{ opacity: 0.9 }}
                onClick={onRecoverLocal}
              >
                Recover this device's draft
              </Button>
            </Flex>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
