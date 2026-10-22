"use client";

import { useEffect, useState } from "react";
import { Box, Checkbox, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { PanelButton, softFieldProps, tileProps } from "./panel-ui";
import { AlertTriangle, Ban, ImageIcon, Link2, Palette } from "lucide-react";
import {
  SCENE_LAYOUT_MIN_DURATION_SEC,
  removeSpeakerLayoutOverrideRange,
  resolveEffectiveFramingMode,
  type SceneLayoutPreset,
} from "@narriflow/validators";
import { useStudio } from "../studio-shell";
import { SceneLayoutPresetGrid } from "./framing-preset-thumbnails";
import {
  activeSceneLayoutChoice,
  applySceneLayoutChoice,
  sceneLayoutEvidenceHint,
  type SceneLayoutChoice,
} from "./layout-panel-model";

const BACKGROUND_SUBMODES: {
  id: "off" | "color" | "image";
  label: string;
  icon: React.ReactNode;
}[] = [
  { id: "off", label: "None", icon: <Ban size={15} /> },
  { id: "color", label: "Color", icon: <Palette size={15} /> },
  { id: "image", label: "Image", icon: <ImageIcon size={15} /> },
];

const SWATCHES = [
  "#000000", "#FFFFFF", "#111827", "#6B7280", "#DC2626",
  "#EA580C", "#CA8A04", "#16A34A", "#2563EB", "#7C3AED",
];
const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function LayoutPanel() {
  const {
    studioEdits,
    setStudioEdits,
    endCoalesce,
    layoutScene,
    aspectRatio,
    editedTimeMap,
  } = useStudio(
    "studioEdits",
    "setStudioEdits",
    "endCoalesce",
    "layoutScene",
    "aspectRatio",
    "editedTimeMap",
  );
  const background = studioEdits.background;
  const clipDefault = resolveEffectiveFramingMode(studioEdits);
  const selected = activeSceneLayoutChoice(
    studioEdits.sceneLayouts,
    aspectRatio,
    layoutScene,
  );
  const hasSourceScene =
    typeof layoutScene?.startSec === "number" &&
    typeof layoutScene.endSec === "number";
  const [applyToAllScenes, setApplyToAllScenes] = useState(false);
  const targetDurationSec = applyToAllScenes
    ? editedTimeMap.editedDurationSec
    : hasSourceScene
      ? layoutScene.endSec! - layoutScene.startSec!
      : 0;
  const targetTooShort =
    hasSourceScene && targetDurationSec < SCENE_LAYOUT_MIN_DURATION_SEC;
  const canApplyLayout = hasSourceScene && !targetTooShort;
  const [colorDraft, setColorDraft] = useState(background.color ?? "#000000");
  const [imageUrlDraft, setImageUrlDraft] = useState(background.imageUrl ?? "");
  const [imageUrlError, setImageUrlError] = useState(false);

  useEffect(() => {
    setColorDraft(background.color ?? "#000000");
    setImageUrlDraft(background.imageUrl ?? "");
    setImageUrlError(false);
  }, [background]);

  const selectLayout = (choice: SceneLayoutChoice) => {
    if (!canApplyLayout || (!applyToAllScenes && choice === selected)) return;
    const startSec = applyToAllScenes ? 0 : layoutScene.startSec!;
    const endSec = applyToAllScenes
      ? editedTimeMap.editedDurationSec
      : layoutScene.endSec!;
    setStudioEdits((previous) => ({
      ...previous,
      sceneLayouts: applySceneLayoutChoice({
        selections: previous.sceneLayouts,
        aspectRatio,
        scene: layoutScene,
        applyToAllScenes,
        editedDurationSec: editedTimeMap.editedDurationSec,
        choice,
        id: `scene-layout-${crypto.randomUUID()}`,
      }),
      speakerLayoutOverrides: removeSpeakerLayoutOverrideRange(
        previous.speakerLayoutOverrides,
        { aspectRatio, startSec, endSec },
      ),
    }));
  };

  const evidenceHint = (preset: SceneLayoutPreset) =>
    sceneLayoutEvidenceHint(preset, layoutScene);
  const selectedHint = selected === "clip-default" ? "ready" : evidenceHint(selected);

  const setBackgroundSubmode = (mode: "off" | "color" | "image") => {
    setStudioEdits((previous) => ({
      ...previous,
      background: { ...previous.background, mode },
    }));
  };
  const setColor = (hex: string, coalesceKey?: string) => {
    setStudioEdits(
      (previous) => ({
        ...previous,
        background: { ...previous.background, mode: "color", color: hex },
      }),
      coalesceKey,
    );
  };
  const applyImageUrl = () => {
    const trimmed = imageUrlDraft.trim();
    if (trimmed && !isValidHttpUrl(trimmed)) {
      setImageUrlError(true);
      return;
    }
    setImageUrlError(false);
    setStudioEdits((previous) => ({
      ...previous,
      background: {
        ...previous.background,
        mode: "image",
        imageUrl: trimmed || null,
      },
    }));
  };

  return (
    <Stack gap="24px" px="20px" pt="16px" pb="20px">
      <Box>
        <Flex align="center" justify="space-between" gap="8px" mb="10px">
          <Box>
            <Text fontSize="13px" fontWeight="500" color="studio.fgMuted">
              Scene layout
            </Text>
            <Text fontSize="12px" color="studio.fgSubtle" mt="2px">
              {hasSourceScene ? "Scene at the playhead" : "No source scene at the playhead"}
            </Text>
          </Box>
          <Checkbox.Root
            checked={applyToAllScenes}
            onCheckedChange={(event) => setApplyToAllScenes(!!event.checked)}
            size="sm"
            colorPalette="accent"
            gap="6px"
            cursor="pointer"
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label>
              <Text fontSize="12px" color="studio.fgMuted" whiteSpace="nowrap">
                Apply to all scenes
              </Text>
            </Checkbox.Label>
          </Checkbox.Root>
        </Flex>

        {layoutScene?.coveredBy === "inserted-scene" ? (
          <Text mb="10px" px="12px" py="10px" borderRadius="10px" bg="studio.subtle" color="studio.fgMuted" fontSize="12px" lineHeight="1.5">
            This playhead is on an inserted scene. Move to source footage to choose its layout.
          </Text>
        ) : layoutScene?.coveredBy === "broll" ? (
          <Text mb="10px" px="12px" py="10px" borderRadius="10px" bg="studio.subtle" color="studio.fgMuted" fontSize="12px" lineHeight="1.5">
            B-roll covers this source scene in the preview. The layout still applies underneath it.
          </Text>
        ) : targetTooShort ? (
          <Text mb="10px" px="12px" py="10px" borderRadius="10px" bg="studio.subtle" color="studio.fgMuted" fontSize="12px" lineHeight="1.5">
            This source scene is too short to save a layout change.
          </Text>
        ) : null}

        <SceneLayoutPresetGrid
          selected={selected}
          onSelect={selectLayout}
          evidenceHint={evidenceHint}
          disabled={!canApplyLayout}
        />

        <Text mt="12px" fontSize="12px" color="studio.fgSubtle" lineHeight="1.5">
          {selected === "clip-default"
            ? `Clip default uses ${clipDefault}. This can be Auto, Center, Fit, Split, or Screen.`
            : selectedHint === "speaker-analysis"
                ? "Speaker analysis is needed. The default framing is shown until analysis is available."
                : selectedHint === "speaker-count"
                  ? "This layout needs more detected speakers. Your current framing is kept."
                : "Applied to the source scene at the playhead."}
        </Text>
      </Box>

      <Box>
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted">
          Clip background
        </Text>
        <Text fontSize="12px" color="studio.fgSubtle" mt="2px" mb="12px">
          Background changes apply to every scene in this clip.
        </Text>
        <Box display="grid" gridTemplateColumns="repeat(3, 1fr)" gap="8px">
          {BACKGROUND_SUBMODES.map((mode) => {
            const active = background.mode === mode.id;
            return (
              <Flex
                key={mode.id}
                as="button"
                aria-pressed={active}
                direction="column"
                align="center"
                justify="center"
                gap="6px"
                py="14px"
                {...tileProps(active)}
                color={active ? "studio.fg" : "studio.fgMuted"}
                onClick={() => setBackgroundSubmode(mode.id)}
              >
                {mode.icon}
                <Text fontSize="12px" fontWeight="500">{mode.label}</Text>
              </Flex>
            );
          })}
        </Box>
      </Box>

      {background.mode === "color" ? (
        <Stack gap="12px">
          <Box display="grid" gridTemplateColumns="repeat(5, 1fr)" gap="8px">
            {SWATCHES.map((hex) => {
              const active = (background.color ?? "#000000").toUpperCase() === hex;
              return (
                <Box
                  key={hex}
                  as="button"
                  aria-label={`Use ${hex}`}
                  aria-pressed={active}
                  onClick={() => setColor(hex)}
                  w="100%"
                  aspectRatio={1}
                  borderRadius="8px"
                  bg={hex}
                  boxShadow={active ? "0 0 0 2px var(--chakra-colors-studio-canvas), 0 0 0 4px var(--chakra-colors-studio-fg)" : "inset 0 0 0 1px rgba(255,255,255,0.08)"}
                  cursor="pointer"
                />
              );
            })}
          </Box>
          <Flex align="center" gap="8px">
            <Box w="40px" h="40px" flexShrink={0} borderRadius="10px" boxShadow="inset 0 0 0 1px rgba(255,255,255,0.08)" bg={HEX_PATTERN.test(colorDraft) ? colorDraft : "studio.subtle"} />
            <Input
              aria-label="Background color hex"
              value={colorDraft}
              onChange={(event) => {
                const next = event.target.value;
                setColorDraft(next);
                if (HEX_PATTERN.test(next)) setColor(next, "bg-color-hex");
              }}
              onBlur={endCoalesce}
              placeholder="#000000"
              size="sm"
              h="40px"
              {...softFieldProps}
              textStyle="data"
            />
          </Flex>
          {!HEX_PATTERN.test(colorDraft) ? (
            <Text fontSize="12px" color="studio.fgSubtle">Use the format #RRGGBB.</Text>
          ) : null}
        </Stack>
      ) : null}

      {background.mode === "image" ? (
        <Stack gap="8px">
          <Flex align="center" gap="10px" px="12px" h="40px" borderRadius="10px" bg="studio.subtle" borderWidth={imageUrlError ? "1px" : "0"} borderColor="studio.dangerBorder">
            <Box color="studio.fgSubtle" flexShrink={0}><Link2 size={13} /></Box>
            <Input
              aria-label="Background image URL"
              placeholder="https://example.com/background.jpg"
              value={imageUrlDraft}
              onChange={(event) => {
                setImageUrlDraft(event.target.value);
                setImageUrlError(false);
              }}
              size="sm"
              flex="1"
              fontSize="13px"
              color="studio.fg"
              css={{ border: "none", outline: "none", background: "transparent", boxShadow: "none" }}
            />
          </Flex>
          {imageUrlError ? (
            <Flex align="center" gap="5px" color="studio.danger">
              <AlertTriangle size={12} />
              <Text fontSize="12px">Enter a valid http(s) image URL.</Text>
            </Flex>
          ) : null}
          <PanelButton onClick={applyImageUrl}>
            <ImageIcon size={15} />
            Apply image
          </PanelButton>
        </Stack>
      ) : null}
    </Stack>
  );
}
