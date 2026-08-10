"use client";

import { useState } from "react";
import { Box, Flex, Slider, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft, Upload, Volume2, VolumeX } from "lucide-react";
import { useStudio } from "../studio-shell";
import { usePreviewPlayer } from "./audio-library";
import { MusicTab } from "./music-tab";
import { SfxTab } from "./sfx-tab";
import { UploadsTab } from "./uploads-tab";

type MusicPanelTab = "music" | "sfx";

const TABS: { id: MusicPanelTab; label: string }[] = [
  { id: "music", label: "Music" },
  { id: "sfx", label: "Sound effects" },
];

export function MusicPanel() {
  const { studioEdits, setStudioEdits, endCoalesce } = useStudio();
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

      <Flex
        px="12px"
        h="43px"
        align="end"
        gap="20px"
        borderBottomWidth="1px"
        borderColor="studio.border"
        role="tablist"
        aria-label="Music library"
      >
        {TABS.map((tab) => {
          const selected = !showUploads && activeTab === tab.id;
          return (
            <Flex
              key={tab.id}
              as="button"
              role="tab"
              aria-selected={selected}
              align="center"
              h="43px"
              pt="2px"
              borderBottomWidth="2px"
              borderColor={selected ? "studio.accent" : "transparent"}
              color={selected ? "studio.fg" : "studio.fgMuted"}
              fontSize="12px"
              fontWeight={selected ? "600" : "500"}
              cursor="pointer"
              transition="border-color 120ms ease, color 120ms ease"
              onClick={() => chooseTab(tab.id)}
            >
              {tab.label}
            </Flex>
          );
        })}
      </Flex>

      {showUploads ? (
        <Box>
          <Flex px="12px" pt="12px" align="center" justify="space-between">
            <Flex
              as="button"
              align="center"
              gap="6px"
              color="studio.fgMuted"
              fontSize="11px"
              fontWeight="600"
              cursor="pointer"
              _hover={{ color: "studio.fg" }}
              onClick={() => setShowUploads(false)}
            >
              <ArrowLeft size={13} /> Back to library
            </Flex>
            <Flex align="center" gap="6px" color="studio.fgMuted">
              <Upload size={13} />
              <Text textStyle="eyebrow">Uploads</Text>
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

      <Box px="12px" pb="12px" pt="4px">
        <Flex align="center" justify="space-between" mb="7px">
          <Text textStyle="eyebrow" color="studio.fgMuted">
            Source audio
          </Text>
          <Flex
            as="button"
            aria-pressed={sourceAudio.muted}
            aria-label={sourceAudio.muted ? "Unmute source audio" : "Mute source audio"}
            align="center"
            gap="5px"
            color={sourceAudio.muted ? "studio.danger" : "studio.fgMuted"}
            fontSize="10.5px"
            fontWeight="600"
            cursor="pointer"
            _hover={{ color: sourceAudio.muted ? "studio.danger" : "studio.fg" }}
            onClick={() => updateSourceAudio({ muted: !sourceAudio.muted })}
          >
            {sourceAudio.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            {sourceAudio.muted ? "Muted" : "Original"}
          </Flex>
        </Flex>
        <Flex
          align="center"
          gap="9px"
          p="10px"
          bg="studio.subtle"
          borderWidth="1px"
          borderColor="studio.border"
          borderRadius="l2"
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
          <Text textStyle="data" fontSize="10.5px" color="studio.fgMuted" w="34px" textAlign="right">
            {sourceAudio.volume}%
          </Text>
        </Flex>
      </Box>
    </Stack>
  );
}
