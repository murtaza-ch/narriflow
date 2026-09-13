"use client";

import { useEffect, useState } from "react";
import { Box, Checkbox, Flex, Input, Stack, Text } from "@chakra-ui/react";
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
    <Stack gap="18px" p="12px">
      <Box>
        <Flex align="center" justify="space-between" gap="8px" mb="10px">
          <Box>
            <Text textStyle="eyebrow" color="studio.fgMuted">
              Scene layout
            </Text>
            <Text fontSize="10px" color="studio.fgSubtle" mt="2px">
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
              <Text fontSize="10.5px" color="studio.fgMuted" whiteSpace="nowrap">
                Apply to all scenes
              </Text>
            </Checkbox.Label>
          </Checkbox.Root>
        </Flex>

        {layoutScene?.coveredBy === "inserted-scene" ? (
          <Text mb="10px" px="8px" py="6px" borderRadius="l1" bg="studio.raised" color="studio.fgMuted" fontSize="10.5px" lineHeight="1.5">
            This playhead is on an inserted scene. Move to source footage to choose its layout.
          </Text>
        ) : layoutScene?.coveredBy === "broll" ? (
          <Text mb="10px" px="8px" py="6px" borderRadius="l1" bg="studio.raised" color="studio.fgMuted" fontSize="10.5px" lineHeight="1.5">
            B-roll covers this source scene in the preview. The layout still applies underneath it.
          </Text>
        ) : targetTooShort ? (
          <Text mb="10px" px="8px" py="6px" borderRadius="l1" bg="studio.raised" color="studio.fgMuted" fontSize="10.5px" lineHeight="1.5">
            This source scene is too short to save a layout change.
          </Text>
        ) : null}

        <SceneLayoutPresetGrid
          selected={selected}
          onSelect={selectLayout}
          evidenceHint={evidenceHint}
          disabled={!canApplyLayout}
        />

        <Text mt="8px" fontSize="10.5px" color="studio.fgSubtle" lineHeight="1.5">
          {selected === "clip-default"
            ? `Clip default uses ${clipDefault}. This can be Auto, Center, Fit, Split, or Screen.`
            : selectedHint === "speaker-analysis"
                ? "Speaker analysis is needed. The default framing is shown until analysis is available."
                : selectedHint === "speaker-count"
                  ? "This layout needs more detected speakers. Your current framing is kept."
                : "Applied to the source scene at the playhead."}
        </Text>
      </Box>

      <Box borderTopWidth="1px" borderColor="studio.border" pt="16px">
        <Text textStyle="eyebrow" color="studio.fgMuted">
          Clip background
        </Text>
        <Text fontSize="10px" color="studio.fgSubtle" mt="2px" mb="10px">
          Background changes apply to every scene in this clip.
        </Text>
        <Box display="grid" gridTemplateColumns="repeat(3, 1fr)" gap="6px">
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
                py="12px"
                borderRadius="l2"
                bg={active ? "studio.raised" : "studio.subtle"}
                borderWidth="1px"
                borderColor={active ? "studio.accent" : "studio.border"}
                color={active ? "studio.accentFg" : "studio.fgMuted"}
                cursor="pointer"
                onClick={() => setBackgroundSubmode(mode.id)}
                _hover={{ borderColor: active ? "studio.accent" : "studio.borderStrong" }}
              >
                {mode.icon}
                <Text fontSize="11px" fontWeight="500">{mode.label}</Text>
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
                  borderRadius="l2"
                  bg={hex}
                  borderWidth={active ? "2px" : "1px"}
                  borderColor={active ? "studio.accent" : "studio.borderStrong"}
                  cursor="pointer"
                />
              );
            })}
          </Box>
          <Flex align="center" gap="8px">
            <Box w="32px" h="32px" flexShrink={0} borderRadius="l2" borderWidth="1px" borderColor="studio.borderStrong" bg={HEX_PATTERN.test(colorDraft) ? colorDraft : "studio.subtle"} />
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
              bg="studio.subtle"
              borderColor="studio.borderControl"
              color="studio.fg"
              textStyle="data"
            />
          </Flex>
          {!HEX_PATTERN.test(colorDraft) ? (
            <Text fontSize="10.5px" color="studio.fgSubtle">Use the format #RRGGBB.</Text>
          ) : null}
        </Stack>
      ) : null}

      {background.mode === "image" ? (
        <Stack gap="8px">
          <Flex align="center" gap="8px" px="10px" h="34px" borderRadius="l2" bg="studio.subtle" borderWidth="1px" borderColor={imageUrlError ? "studio.dangerBorder" : "studio.borderControl"}>
            <Box color="studio.fgSubtle" flexShrink={0}><Link2 size={13} /></Box>
            <Input
              aria-label="Background image URL"
              placeholder="https://example.com/background.jpg"
              value={imageUrlDraft}
              onChange={(event) => {
                setImageUrlDraft(event.target.value);
                setImageUrlError(false);
              }}
              size="xs"
              flex="1"
              fontSize="12px"
              color="studio.fg"
              css={{ border: "none", outline: "none", background: "transparent", boxShadow: "none" }}
            />
          </Flex>
          {imageUrlError ? (
            <Flex align="center" gap="5px" color="studio.danger">
              <AlertTriangle size={12} />
              <Text fontSize="10.5px">Enter a valid http(s) image URL.</Text>
            </Flex>
          ) : null}
          <Flex as="button" align="center" justify="center" h="34px" borderRadius="l2" bg="studio.raised" borderWidth="1px" borderColor="studio.borderStrong" color="studio.fg" fontSize="12px" fontWeight="600" cursor="pointer" gap="6px" onClick={applyImageUrl}>
            <ImageIcon size={13} />
            Apply image
          </Flex>
        </Stack>
      ) : null}
    </Stack>
  );
}
