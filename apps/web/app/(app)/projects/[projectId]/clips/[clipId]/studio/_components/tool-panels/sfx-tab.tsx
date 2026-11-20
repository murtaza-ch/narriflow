import { useMemo } from "react";
import { Box, Flex, Slider, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Sparkles, X } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import { STUDIO_EDIT_LIMITS } from "@narriflow/validators";
import { formatTimecode } from "@/lib/format";
import { useStudio } from "../studio-shell";
import { brandAudioRows, type AudioAssetListRow, type PreviewPlayer } from "./audio-library";
import { AudioBrowser, type AudioBrowserLabels } from "./audio-list";
import { SectionLabel, studioSliderCss } from "./panel-ui";

const MAX_SFX_PLACEMENTS = STUDIO_EDIT_LIMITS.sfx;

interface SfxTabProps {
  player: PreviewPlayer;
  onOpenUploads: () => void;
}

const SFX_LABELS: AudioBrowserLabels = {
  searchLabel: "sound effects",
  searchPlaceholder: "Search effects…",
  clearSearchLabel: "Clear effect search",
  loadingLabel: "Loading effects",
  emptyTitle: "No effects yet",
  emptyHint: "Free-to-use effects will show up here.",
  savedTitle: "No saved effects",
  savedHint: "Star an effect and it collects here.",
  uploadLabel: "Upload an effect",
  emptyIcon: <Sparkles size={18} />,
};

export function SfxTab({ player, onOpenUploads }: SfxTabProps) {
  const { studioEdits, setStudioEdits, endCoalesce, playbackClock, brandAudio } = useStudio("studioEdits", "setStudioEdits", "endCoalesce", "playbackClock", "brandAudio");
  const placements = studioEdits.sfx;
  const atCap = placements.length >= MAX_SFX_PLACEMENTS;

  const brandRows = useMemo(() => brandAudioRows(brandAudio.sfx, "sfx"), [brandAudio.sfx]);
  const addAtPlayhead = (asset: AudioAssetListRow) => {
    if (atCap) return;
    const startSec = Math.max(0, playbackClock.getSnapshot());
    setStudioEdits((prev) => ({
      ...prev,
      sfx: [
        ...prev.sfx,
        { id: crypto.randomUUID(), assetId: asset.id, title: asset.title, startSec, volume: 80 },
      ],
    }));
    toaster.create({
      type: "success",
      title: `${asset.title} added`,
      description: `Placed at ${formatTimecode(startSec)}.`,
    });
  };

  const updatePlacementVolume = (id: string, volume: number) =>
    setStudioEdits(
      (prev) => ({
        ...prev,
        sfx: prev.sfx.map((placement) => placement.id === id ? { ...placement, volume } : placement),
      }),
      `sfx-volume-${id}`,
    );

  return (
    <Flex direction="column" flex="1" gap="4" px="5" pt="4" pb="4">
      <AudioBrowser
        kind="sfx"
        labels={SFX_LABELS}
        player={player}
        brandRows={brandRows}
        onOpenUploads={onOpenUploads}
        rowAction={(asset) => ({ ariaLabel: `Add ${asset.title} at playhead`, disabled: atCap, onClick: () => addAtPlayhead(asset) })}
        onFavoriteFailed={() => toaster.create({ type: "error", title: "Couldn't update Saved effects" })}
        notice={
          atCap ? (
            <Flex align="center" gap="2" px="3" py="2.5" bg="studio.subtle" borderRadius="10px" color="warning.fg">
              <AlertTriangle size={13} />
              <Text fontSize="12px">Remove an effect before adding another.</Text>
            </Flex>
          ) : null
        }
      />

      <Box>
        <SectionLabel action={<Text textStyle="data" fontSize="12px" color="studio.fgSubtle">{placements.length}/{MAX_SFX_PLACEMENTS}</Text>}>
          On this clip
        </SectionLabel>
        {placements.length === 0 ? (
          <Flex align="center" h="40px" px="3" bg="studio.subtle" borderRadius="12px" color="studio.fgSubtle" fontSize="13px">
            Effects are added at the playhead.
          </Flex>
        ) : (
          <Stack gap="2">
            {[...placements].sort((a, b) => a.startSec - b.startSec).map((placement) => (
              <Stack key={placement.id} gap="3" p="3" bg="studio.subtle" borderRadius="12px">
                <Flex align="center" justify="space-between" gap="2">
                  <Flex align="center" gap="2" minW="0">
                    <Text textStyle="data" fontSize="12px" color="studio.timecode">{formatTimecode(placement.startSec)}</Text>
                    <Text fontSize="13px" color="studio.fg" fontWeight="500" truncate>{placement.title ?? "Sound effect"}</Text>
                  </Flex>
                  <Flex
                    as="button"
                    aria-label={`Remove ${placement.title ?? "sound effect"}`}
                    minW="24px"
                    minH="24px"
                    align="center"
                    justify="center"
                    color="studio.fgMuted"
                    cursor="pointer"
                    _hover={{ color: "studio.danger" }}
                    onClick={() => setStudioEdits((prev) => ({ ...prev, sfx: prev.sfx.filter((item) => item.id !== placement.id) }))}
                  >
                    <X size={14} />
                  </Flex>
                </Flex>
                <Flex align="center" gap="3">
                  <Slider.Root
                    aria-label={[`${placement.title ?? "Sound effect"} volume`]}
                    value={[placement.volume]}
                    min={0}
                    max={100}
                    onValueChange={(event) => updatePlacementVolume(placement.id, event.value[0] ?? placement.volume)}
                    onValueChangeEnd={endCoalesce}
                    size="sm"
                    css={studioSliderCss}
                    flex="1"
                  >
                    <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
                  </Slider.Root>
                  <Text textStyle="data" fontSize="12px" color="studio.fgMuted" w="40px" textAlign="right">{placement.volume}%</Text>
                </Flex>
              </Stack>
            ))}
          </Stack>
        )}
      </Box>
    </Flex>
  );
}
