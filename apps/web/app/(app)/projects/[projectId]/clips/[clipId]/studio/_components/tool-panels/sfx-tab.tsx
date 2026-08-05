"use client";

import { Box, Flex, Text, Stack, Slider } from "@chakra-ui/react";
import { AlertTriangle, Pause, Play, Plus, X } from "lucide-react";
import { formatDuration, formatTimecode } from "@/lib/format";
import { useStudio } from "../studio-shell";
import { useAudioAssetList, type AudioAssetListRow } from "./audio-library";
import type { usePreviewPlayer } from "./audio-library";

const MAX_SFX_PLACEMENTS = 20;

interface SfxTabProps {
  reloadKey: number;
  player: ReturnType<typeof usePreviewPlayer>;
}

function SfxRow({
  asset,
  isPreviewing,
  onTogglePreview,
  onAdd,
  disabled,
}: {
  asset: AudioAssetListRow;
  isPreviewing: boolean;
  onTogglePreview: () => void;
  onAdd: () => void;
  disabled: boolean;
}) {
  return (
    <Flex
      align="center"
      gap="8px"
      p="8px"
      borderRadius="l2"
      bg="studio.subtle"
      border="1px solid"
      borderColor="studio.border"
    >
      <Box
        as="button"
        aria-label={isPreviewing ? `Pause ${asset.title}` : `Preview ${asset.title}`}
        flexShrink={0}
        w="26px"
        h="26px"
        display="flex"
        alignItems="center"
        justifyContent="center"
        borderRadius="full"
        bg="studio.raised"
        borderWidth="1px"
        borderColor="studio.borderStrong"
        color="studio.fg"
        cursor="pointer"
        _hover={{ borderColor: "studio.accent" }}
        transition="border-color 120ms ease"
        onClick={onTogglePreview}
      >
        {isPreviewing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
      </Box>
      <Stack gap="0" minW="0" flex="1">
        <Text fontSize="12px" color="studio.fg" fontWeight="500" truncate>
          {asset.title}
        </Text>
        <Text textStyle="data" fontSize="10.5px" color="studio.fgMuted">
          {formatDuration(asset.durationSec)}
          {asset.scope === "user" ? " · uploaded" : ""}
        </Text>
      </Stack>
      <Box
        as="button"
        aria-label={`Add ${asset.title} at playhead`}
        aria-disabled={disabled}
        flexShrink={0}
        display="flex"
        alignItems="center"
        gap="4px"
        h="24px"
        px="9px"
        borderRadius="l2"
        borderWidth="1px"
        borderColor="studio.borderControl"
        bg="studio.subtle"
        color={disabled ? "fg.disabled" : "studio.fgMuted"}
        fontSize="10.5px"
        fontWeight="600"
        cursor={disabled ? "not-allowed" : "pointer"}
        opacity={disabled ? 0.6 : 1}
        _hover={disabled ? {} : { borderColor: "studio.accent", color: "studio.fg" }}
        transition="border-color 120ms ease, color 120ms ease"
        onClick={disabled ? undefined : onAdd}
      >
        <Plus size={11} />
        Add
      </Box>
    </Flex>
  );
}

export function SfxTab({ reloadKey, player }: SfxTabProps) {
  const { studioEdits, setStudioEdits, endCoalesce, playbackClock } = useStudio();
  const { assets, loading, error } = useAudioAssetList("sfx", null, reloadKey);
  const placements = studioEdits.sfx;
  const atCap = placements.length >= MAX_SFX_PLACEMENTS;

  const addAtPlayhead = (asset: AudioAssetListRow) => {
    if (atCap) return;
    const id = crypto.randomUUID();
    const startSec = Math.max(0, playbackClock.getSnapshot());
    setStudioEdits((prev) => ({
      ...prev,
      sfx: [...prev.sfx, { id, assetId: asset.id, title: asset.title, startSec, volume: 80 }],
    }));
  };

  const removePlacement = (id: string) => {
    setStudioEdits((prev) => ({ ...prev, sfx: prev.sfx.filter((p) => p.id !== id) }));
  };

  const updatePlacementVolume = (id: string, volume: number, coalesceKey?: string) => {
    setStudioEdits(
      (prev) => ({
        ...prev,
        sfx: prev.sfx.map((p) => (p.id === id ? { ...p, volume } : p)),
      }),
      coalesceKey,
    );
  };

  return (
    <Stack gap="14px" p="12px">
      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
          Sound effects
        </Text>
        {atCap ? (
          <Flex align="center" gap="6px" mb="8px" color="studio.fgSubtle">
            <AlertTriangle size={12} />
            <Text fontSize="10.5px">
              {MAX_SFX_PLACEMENTS} placements is the limit for one clip — remove one to add another.
            </Text>
          </Flex>
        ) : null}
        <Box maxH="220px" overflowY="auto">
          <Stack gap="6px">
            {loading ? (
              <Text fontSize="12px" color="studio.fgMuted" py="8px">
                Loading sound effects…
              </Text>
            ) : error ? (
              <Text fontSize="12px" color="danger.400" py="8px">
                {error}
              </Text>
            ) : assets.length === 0 ? (
              <Text fontSize="12px" color="studio.fgMuted" py="8px">
                No sound effects yet.
              </Text>
            ) : (
              assets.map((asset) => (
                <SfxRow
                  key={asset.id}
                  asset={asset}
                  isPreviewing={player.playingId === asset.id}
                  onTogglePreview={() => player.toggle(asset.id, asset.playbackUrl)}
                  onAdd={() => addAtPlayhead(asset)}
                  disabled={atCap}
                />
              ))
            )}
          </Stack>
        </Box>
      </Box>

      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
          Placed on this clip ({placements.length}/{MAX_SFX_PLACEMENTS})
        </Text>
        {placements.length === 0 ? (
          <Text fontSize="12px" color="studio.fgMuted">
            Nothing placed yet — add one at the playhead above.
          </Text>
        ) : (
          <Stack gap="8px">
            {[...placements]
              .sort((a, b) => a.startSec - b.startSec)
              .map((placement) => (
                <Flex
                  key={placement.id}
                  direction="column"
                  gap="6px"
                  p="10px"
                  borderRadius="l2"
                  bg="studio.subtle"
                  borderWidth="1px"
                  borderColor="studio.border"
                >
                  <Flex align="center" justify="space-between" gap="8px">
                    <Flex align="center" gap="8px" minW="0">
                      <Text textStyle="data" fontSize="11px" color="studio.timecode" flexShrink={0}>
                        {formatTimecode(placement.startSec)}
                      </Text>
                      <Text fontSize="11px" color="studio.fg" fontWeight="500" truncate>
                        {placement.title ?? "Sound effect"}
                      </Text>
                    </Flex>
                    <Box
                      as="button"
                      aria-label="Remove sound effect"
                      color="studio.fgMuted"
                      cursor="pointer"
                      flexShrink={0}
                      _hover={{ color: "studio.fg" }}
                      transition="color 120ms ease"
                      onClick={() => removePlacement(placement.id)}
                    >
                      <X size={13} />
                    </Box>
                  </Flex>
                  <Flex align="center" gap="8px">
                    <Slider.Root
                      aria-label={[`${placement.title ?? "Sound effect"} volume`]}
                      value={[placement.volume]}
                      min={0}
                      max={100}
                      onValueChange={(event) =>
                        updatePlacementVolume(placement.id, event.value[0] ?? placement.volume, `sfx-volume-${placement.id}`)
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
                    <Text textStyle="data" fontSize="11px" color="studio.fgMuted" w="34px" textAlign="right">
                      {placement.volume}%
                    </Text>
                  </Flex>
                </Flex>
              ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
