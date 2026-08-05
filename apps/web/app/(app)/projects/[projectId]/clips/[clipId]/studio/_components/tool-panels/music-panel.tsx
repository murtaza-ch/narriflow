"use client";

import { useState } from "react";
import { Box, Flex, Stack, Slider, Text } from "@chakra-ui/react";
import { Volume2, VolumeX } from "lucide-react";
import { useStudio } from "../studio-shell";
import { usePreviewPlayer } from "./audio-library";
import { MusicTab } from "./music-tab";
import { SfxTab } from "./sfx-tab";
import { UploadsTab } from "./uploads-tab";

type MusicPanelTab = "music" | "sfx" | "uploads";

const TABS: { id: MusicPanelTab; label: string }[] = [
  { id: "music", label: "Music" },
  { id: "sfx", label: "SFX" },
  { id: "uploads", label: "Uploads" },
];

/**
 * Music/SFX library panel (docs/plans/vizard-parity.md "Music/SFX library").
 * Three tabs share one hidden `<audio>` preview element (`usePreviewPlayer`)
 * so clicking Play on any row — in the Music tab's track list or the SFX
 * tab's effect list — pauses whatever the panel was already previewing.
 * `libraryVersion` is bumped by the Uploads tab after a finalize/delete so
 * the Music and SFX tabs' lists refetch without a shared cache layer.
 */
export function MusicPanel() {
  const { studioEdits, setStudioEdits, endCoalesce } = useStudio();
  const [activeTab, setActiveTab] = useState<MusicPanelTab>("music");
  const [libraryVersion, setLibraryVersion] = useState(0);
  const player = usePreviewPlayer();

  const sourceAudio = studioEdits.sourceAudio;
  const updateSourceAudio = (patch: Partial<typeof sourceAudio>, coalesceKey?: string) =>
    setStudioEdits((prev) => ({ ...prev, sourceAudio: { ...prev.sourceAudio, ...patch } }), coalesceKey);

  return (
    <Stack gap="0">
      {/* biome-ignore lint/a11y/useMediaCaption: shared hidden preview element for browsing the library — no dialogue/captions of its own. */}
      <audio ref={player.audioRef} preload="none" style={{ display: "none" }} />

      {/* Source audio — the original clip's dialogue track. Lives above the
          tabs since it applies regardless of which library tab is open. */}
      <Box px="12px" pt="12px">
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
          Source audio
        </Text>
        <Box p="12px" bg="studio.subtle" borderRadius="l2" borderWidth="1px" borderColor="studio.border">
          <Flex align="center" justify="space-between" mb="10px">
            <Flex align="center" gap="6px" color="studio.fgMuted">
              {sourceAudio.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              <Text fontSize="12px" color="studio.fg" fontWeight="500">
                Original audio
              </Text>
            </Flex>
            <Flex
              as="button"
              aria-pressed={sourceAudio.muted}
              aria-label={sourceAudio.muted ? "Unmute source audio" : "Mute source audio"}
              align="center"
              justify="center"
              gap="5px"
              h="24px"
              px="9px"
              borderRadius="l2"
              borderWidth="1px"
              borderColor={sourceAudio.muted ? "studio.dangerBorder" : "studio.borderControl"}
              bg={sourceAudio.muted ? "studio.raised" : "studio.subtle"}
              color={sourceAudio.muted ? "studio.danger" : "studio.fgMuted"}
              fontSize="10.5px"
              fontWeight="600"
              cursor="pointer"
              transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
              _hover={{ borderColor: sourceAudio.muted ? "studio.dangerBorder" : "studio.fgSubtle" }}
              onClick={() => updateSourceAudio({ muted: !sourceAudio.muted })}
            >
              {sourceAudio.muted ? "Muted" : "Mute"}
            </Flex>
          </Flex>
          <Flex align="center" gap="8px" opacity={sourceAudio.muted ? 0.5 : 1}>
            <Box color="studio.fgMuted" flexShrink={0}>
              <Volume2 size={14} />
            </Box>
            <Slider.Root
              aria-label={["Source audio volume"]}
              value={[sourceAudio.volume]}
              min={0}
              max={100}
              onValueChange={(event) => updateSourceAudio({ volume: event.value[0] ?? 100 }, "source-volume")}
              onValueChangeEnd={endCoalesce}
              size="sm"
              colorPalette="accent"
              flex="1"
            >
              <Slider.Control>
                <Slider.Track>
                  <Slider.Range />
                </Slider.Track>
                <Slider.Thumbs />
              </Slider.Control>
            </Slider.Root>
            <Text textStyle="data" fontSize="11px" color="studio.fgMuted" w="34px" textAlign="right">
              {sourceAudio.volume}%
            </Text>
          </Flex>
        </Box>
      </Box>

      {/* Tabs */}
      <Flex px="12px" pt="14px" gap="4px" mb="4px" role="tablist" aria-label="Music library">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <Flex
              key={tab.id}
              as="button"
              role="tab"
              aria-selected={isActive}
              align="center"
              px="12px"
              py="6px"
              borderRadius="l2"
              bg={isActive ? "studio.raised" : "transparent"}
              border="1px solid"
              borderColor={isActive ? "studio.borderStrong" : "transparent"}
              color={isActive ? "studio.fg" : "studio.fgMuted"}
              cursor="pointer"
              fontSize="12px"
              fontWeight="500"
              onClick={() => setActiveTab(tab.id)}
              transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
            >
              {tab.label}
            </Flex>
          );
        })}
      </Flex>

      {activeTab === "music" ? <MusicTab reloadKey={libraryVersion} player={player} /> : null}
      {activeTab === "sfx" ? <SfxTab reloadKey={libraryVersion} player={player} /> : null}
      {activeTab === "uploads" ? (
        <UploadsTab reloadKey={libraryVersion} onLibraryChange={() => setLibraryVersion((v) => v + 1)} />
      ) : null}
    </Stack>
  );
}
