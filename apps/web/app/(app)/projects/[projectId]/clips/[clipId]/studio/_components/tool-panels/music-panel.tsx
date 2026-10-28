"use client";

import { useState } from "react";
import { Box, Flex, Slider, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft, Upload, Volume2, VolumeX } from "lucide-react";
import { useStudio } from "../studio-shell";
import { usePreviewPlayer } from "./audio-library";
import { MusicTab } from "./music-tab";
import { SfxTab } from "./sfx-tab";
import { UploadsTab } from "./uploads-tab";
import { PANEL_PX, PanelTabs, SectionLabel, studioSliderCss } from "./panel-ui";

type MusicPanelTab = "music" | "sfx";

const TABS: { id: MusicPanelTab; label: string }[] = [
  { id: "music", label: "Music" },
  { id: "sfx", label: "Sound effects" },
];

export function MusicPanel() {
  const { studioEdits, setStudioEdits, endCoalesce } = useStudio("studioEdits", "setStudioEdits", "endCoalesce");
  const [activeTab, setActiveTab] = useState<MusicPanelTab>("music");
  const [showUploads, setShowUploads] = useState(false);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const player = usePreviewPlayer();
  const sourceAudio = studioEdits.sourceAudio;

  const updateSourceAudio = (patch: Partial<typeof sourceAudio>, coalesceKey?: string) =>
    setStudioEdits(
      (prev) => ({ ...prev, sourceAudio: { ...prev.sourceAudio, ...patch } }),
      coalesceKey,
    );

  const chooseTab = (tab: MusicPanelTab) => {
    setActiveTab(tab);
    setShowUploads(false);
  };

  return (
    <Stack gap="0">
      {/* biome-ignore lint/a11y/useMediaCaption: private library previews contain no dialogue. */}
      <audio ref={player.audioRef} preload="metadata" style={{ display: "none" }} />

      {/* No tab is current while the uploads view is open. */}
      <PanelTabs<MusicPanelTab | "uploads">
        ariaLabel="Music library"
        items={TABS}
        value={showUploads ? "uploads" : activeTab}
        onChange={(tab) => tab !== "uploads" && chooseTab(tab)}
      />

      {showUploads ? (
        <Box>
          <Flex px={PANEL_PX} pt="4" align="center" justify="space-between">
            <Flex
              as="button"
              align="center"
              gap="1.5"
              minH="24px"
              color="studio.fgMuted"
              fontSize="13px"
              fontWeight="500"
              cursor="pointer"
              _hover={{ color: "studio.fg" }}
              onClick={() => setShowUploads(false)}
            >
              <ArrowLeft size={14} /> Back to library
            </Flex>
            <Flex align="center" gap="1.5" color="studio.fg">
              <Upload size={14} />
              <Text fontSize="13px" fontWeight="500">Uploads</Text>
            </Flex>
          </Flex>
          <UploadsTab
            reloadKey={libraryVersion}
            onLibraryChange={() => setLibraryVersion((version) => version + 1)}
          />
        </Box>
      ) : activeTab === "music" ? (
        <MusicTab
          reloadKey={libraryVersion}
          player={player}
          onOpenUploads={() => setShowUploads(true)}
        />
      ) : (
        <SfxTab
          reloadKey={libraryVersion}
          player={player}
          onOpenUploads={() => setShowUploads(true)}
        />
      )}

      <Box px={PANEL_PX} pb="5" pt="2">
        <SectionLabel
          action={
            <Flex
              as="button"
              aria-pressed={sourceAudio.muted}
              aria-label={sourceAudio.muted ? "Unmute source audio" : "Mute source audio"}
              h="28px"
              minW="24px"
              px="2.5"
              align="center"
              gap="1.5"
              borderRadius="8px"
              bg="studio.subtle"
              color={sourceAudio.muted ? "studio.danger" : "studio.fgMuted"}
              fontSize="12px"
              fontWeight="500"
              cursor="pointer"
              transition="background 120ms ease, color 120ms ease"
              _hover={{ bg: "studio.surface", color: sourceAudio.muted ? "studio.danger" : "studio.fg" }}
              onClick={() => updateSourceAudio({ muted: !sourceAudio.muted })}
            >
              {sourceAudio.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              {sourceAudio.muted ? "Muted" : "Original"}
            </Flex>
          }
        >
          Source audio
        </SectionLabel>
        <Flex
          align="center"
          gap="3"
          px="4"
          h="44px"
          bg="studio.subtle"
          borderRadius="12px"
          opacity={sourceAudio.muted ? 0.6 : 1}
        >
          <Slider.Root
            aria-label={["Source audio volume"]}
            value={[sourceAudio.volume]}
            min={0}
            max={100}
            disabled={sourceAudio.muted}
            onValueChange={(event) =>
              updateSourceAudio(
                { volume: event.value[0] ?? sourceAudio.volume },
                "source-audio-volume",
              )
            }
            onValueChangeEnd={endCoalesce}
            size="sm"
            css={studioSliderCss}
            flex="1"
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <Text textStyle="data" fontSize="12px" color="studio.fgMuted" w="44px" textAlign="right">
            {sourceAudio.volume}%
          </Text>
        </Flex>
      </Box>
    </Stack>
  );
}
