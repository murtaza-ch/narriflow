"use client";

import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import {
  SCENE_LAYOUT_PRESET_CATALOG,
  resolveSceneLayoutPresetTemplate,
  type SceneLayoutPresetDefinition,
  type ResolvedSceneLayoutTemplateLayer,
} from "@narriflow/composition-plan";
import type { SceneLayoutPreset } from "@narriflow/validators";
import type { SceneLayoutChoice } from "./layout-panel-model";

const THUMBNAIL_CANVAS = { width: 900, height: 1600 } as const;
const THUMBNAIL_HEIGHT_PX = 64;

const CATEGORY_LABELS: Record<SceneLayoutPresetDefinition["category"], string> = {
  automatic: "Automatic",
  "speaker-source": "Speaker + source",
  "speaker-only": "Speakers",
  "source-only": "Source",
};

export const SCENE_LAYOUT_CHOICES: readonly SceneLayoutChoice[] = [
  "clip-default",
  ...SCENE_LAYOUT_PRESET_CATALOG.map((preset) => preset.id),
];

function frameStyle(frame: ResolvedSceneLayoutTemplateLayer["frame"]) {
  return {
    left: `${(frame.x / THUMBNAIL_CANVAS.width) * 100}%`,
    top: `${(frame.y / THUMBNAIL_CANVAS.height) * 100}%`,
    width: `${(frame.width / THUMBNAIL_CANVAS.width) * 100}%`,
    height: `${(frame.height / THUMBNAIL_CANVAS.height) * 100}%`,
  };
}

function maskRadius(layer: ResolvedSceneLayoutTemplateLayer): string | undefined {
  if (!layer.mask) return undefined;
  if (layer.mask.kind === "circle") return "50%";
  return `${layer.mask.radiusPx * (THUMBNAIL_HEIGHT_PX / THUMBNAIL_CANVAS.height)}px`;
}

function SpeakerGlyph() {
  return (
    <Flex position="absolute" inset="0" direction="column" align="center" justify="center">
      <Box w="23%" maxW="9px" aspectRatio={1} borderRadius="full" bg="currentColor" />
      <Box w="48%" maxW="18px" h="20%" minH="3px" mt="2px" borderRadius="50% 50% 18% 18%" bg="currentColor" />
    </Flex>
  );
}

function SourceGlyph({ fit }: { fit: "cover" | "contain" }) {
  return (
    <Flex position="absolute" inset="0" align="center" justify="center" bg="studio.surface">
      <Box
        position="relative"
        w={fit === "contain" ? "82%" : "100%"}
        h={fit === "contain" ? "48%" : "100%"}
        minH="4px"
        borderWidth="1px"
        borderColor="currentColor"
        opacity={0.72}
      >
        <Box position="absolute" top="28%" left="12%" w="56%" h="1px" bg="currentColor" />
        <Box position="absolute" top="50%" left="12%" w="38%" h="1px" bg="currentColor" />
      </Box>
    </Flex>
  );
}

function TemplateLayer({ layer }: { layer: ResolvedSceneLayoutTemplateLayer }) {
  return (
    <Box
      position="absolute"
      style={frameStyle(layer.frame)}
      overflow="hidden"
      borderRadius={maskRadius(layer)}
      borderWidth="1px"
      borderColor="studio.borderStrong"
      bg={layer.kind === "speaker" ? "studio.raised" : "studio.surface"}
    >
      {layer.kind === "speaker" ? <SpeakerGlyph /> : <SourceGlyph fit={layer.fit} />}
    </Box>
  );
}

function LayoutArt({ preset }: { preset: SceneLayoutPresetDefinition | null }) {
  const layers = preset
    ? resolveSceneLayoutPresetTemplate(preset.id, THUMBNAIL_CANVAS)
    : [];
  return (
    <Flex h="70px" align="center" justify="center" bg="studio.canvas" borderRadius="l1">
      <Box
        position="relative"
        h={`${THUMBNAIL_HEIGHT_PX}px`}
        aspectRatio={THUMBNAIL_CANVAS.width / THUMBNAIL_CANVAS.height}
        overflow="hidden"
        bg="black"
        color="studio.fgMuted"
        borderWidth="1px"
        borderColor="studio.border"
      >
        {preset?.id === "auto" ? (
          <>
            <SpeakerGlyph />
            <Box position="absolute" inset="14%" borderWidth="1px" borderStyle="dashed" borderColor="studio.accent" />
          </>
        ) : preset ? (
          layers.map((layer, index) => (
            <TemplateLayer key={`${layer.kind}-${layer.subjectIndex ?? "source"}-${index}`} layer={layer} />
          ))
        ) : (
          <>
            <SpeakerGlyph />
            <Box position="absolute" inset="14%" borderWidth="1px" borderStyle="dashed" borderColor="studio.borderStrong" />
          </>
        )}
      </Box>
    </Flex>
  );
}

function LayoutCard({
  choice,
  preset,
  active,
  disabled,
  hint,
  onSelect,
}: {
  choice: SceneLayoutChoice;
  preset: SceneLayoutPresetDefinition | null;
  active: boolean;
  disabled: boolean;
  hint: "ready" | "speaker-analysis" | "speaker-count";
  onSelect: (choice: SceneLayoutChoice) => void;
}) {
  const label = preset?.label ?? "Clip default";
  const minimumSpeakers = preset?.minimumSpeakers ?? 0;
  const availability = hint === "speaker-analysis"
    ? ", analysis needed"
    : hint === "speaker-count"
      ? `, needs ${minimumSpeakers} detected ${minimumSpeakers === 1 ? "speaker" : "speakers"}`
      : "";
  return (
    <Flex
      as="button"
      direction="column"
      alignItems="stretch"
      justifyContent="flex-start"
      w="100%"
      h="auto"
      minH="108px"
      minW="0"
      p="6px"
      gap="6px"
      borderWidth="1px"
      borderColor={active ? "studio.ring" : "studio.border"}
      borderRadius="l2"
      bg={active ? "studio.raised" : "studio.subtle"}
      color={active ? "studio.fg" : "studio.fgSubtle"}
      cursor={disabled ? "not-allowed" : "pointer"}
      opacity={disabled ? 0.5 : 1}
      aria-disabled={disabled}
      aria-pressed={active}
      aria-label={choice === "clip-default" ? "Use clip default layout" : `Use ${label} layout${availability}`}
      onClick={() => {
        if (!disabled) onSelect(choice);
      }}
      _hover={disabled ? undefined : { borderColor: active ? "studio.ring" : "studio.borderStrong" }}
    >
      <Box position="relative">
        <LayoutArt preset={preset} />
        {hint !== "ready" ? (
          <Text position="absolute" right="4px" bottom="3px" px="4px" py="1px" borderRadius="full" bg="studio.surface/92" color="studio.fgSubtle" fontSize="8px" lineHeight="1.4">
            {hint === "speaker-count"
              ? `${minimumSpeakers} ${minimumSpeakers === 1 ? "speaker" : "speakers"}`
              : "Analyze"}
          </Text>
        ) : null}
      </Box>
      <Text color={active ? "studio.accentFg" : "studio.fgMuted"} fontSize="10.5px" fontWeight={active ? "600" : "500"} textAlign="left" lineHeight="1.25" lineClamp="2">
        {label}
      </Text>
    </Flex>
  );
}

export function SceneLayoutPresetGrid({
  selected,
  onSelect,
  evidenceHint,
  disabled,
}: {
  selected: SceneLayoutChoice;
  onSelect: (choice: SceneLayoutChoice) => void;
  evidenceHint: (preset: SceneLayoutPreset) =>
    | "ready"
    | "speaker-analysis"
    | "speaker-count";
  disabled: boolean;
}) {
  const categories = Object.keys(CATEGORY_LABELS) as Array<
    SceneLayoutPresetDefinition["category"]
  >;
  return (
    <Stack gap="14px">
      {categories.map((category) => {
        const presets = SCENE_LAYOUT_PRESET_CATALOG.filter(
          (preset) => preset.category === category,
        );
        if (presets.length === 0) return null;
        return (
          <Box key={category}>
            <Text mb="6px" fontSize="9.5px" fontWeight="600" color="studio.fgSubtle">
              {CATEGORY_LABELS[category]}
            </Text>
            <Box display="grid" gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="8px">
              {category === "automatic" ? (
                <LayoutCard
                  choice="clip-default"
                  preset={null}
                  active={selected === "clip-default"}
                  disabled={disabled}
                  hint="ready"
                  onSelect={onSelect}
                />
              ) : null}
              {presets.map((preset) => (
                <LayoutCard
                  key={preset.id}
                  choice={preset.id}
                  preset={preset}
                  active={selected === preset.id}
                  disabled={disabled}
                  hint={evidenceHint(preset.id)}
                  onSelect={onSelect}
                />
              ))}
            </Box>
          </Box>
        );
      })}
    </Stack>
  );
}
