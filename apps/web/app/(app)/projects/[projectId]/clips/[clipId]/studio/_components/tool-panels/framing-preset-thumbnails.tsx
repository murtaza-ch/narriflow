"use client";

import { Box, Flex, Text } from "@chakra-ui/react";
import type { EffectiveFramingMode } from "@narriflow/validators";

// Vizard-style layout picker: a grid of drawn 9:16 mini-mockups (no icon +
// label rows). Each tile is a small hand-drawn scene built from Box/Flex
// primitives on studio.* tokens — see layout-panel.tsx's top-of-file comment
// for the framing/background truth model these three presets encode.

const FRAMING_PRESETS: { id: EffectiveFramingMode; label: string }[] = [
  { id: "auto", label: "Auto reframe" },
  { id: "center", label: "Center crop" },
  { id: "fit", label: "Fit" },
];

function CornerBrackets({
  top,
  left,
  size,
  color,
}: {
  top: string;
  left: string;
  size: string;
  color: string;
}) {
  const arm = "6px";
  return (
    <>
      <Box position="absolute" top={top} left={left} w={arm} h={arm} borderTopWidth="1.5px" borderLeftWidth="1.5px" borderColor={color} />
      <Box position="absolute" top={top} left={`calc(${left} + ${size} - ${arm})`} w={arm} h={arm} borderTopWidth="1.5px" borderRightWidth="1.5px" borderColor={color} />
      <Box position="absolute" top={`calc(${top} + ${size} - ${arm})`} left={left} w={arm} h={arm} borderBottomWidth="1.5px" borderLeftWidth="1.5px" borderColor={color} />
      <Box position="absolute" top={`calc(${top} + ${size} - ${arm})`} left={`calc(${left} + ${size} - ${arm})`} w={arm} h={arm} borderBottomWidth="1.5px" borderRightWidth="1.5px" borderColor={color} />
    </>
  );
}

// Shared person silhouette (circle head + rounded-rect shoulders) used by
// both crop-to-fill presets — Auto and Center only differ in the overlay
// cue drawn on top of it.
function Silhouette({ color }: { color: string }) {
  return (
    <>
      <Box position="absolute" top="12px" left="50%" transform="translateX(-50%)" w="20px" h="20px" borderRadius="full" bg={color} />
      <Box
        position="absolute"
        bottom="8px"
        left="50%"
        transform="translateX(-50%)"
        w="36px"
        h="26px"
        bg={color}
        css={{ borderTopLeftRadius: "10px", borderTopRightRadius: "10px" }}
      />
    </>
  );
}

function FramingPresetArt({
  mode,
  shapeColor,
  cueColor,
}: {
  mode: EffectiveFramingMode;
  shapeColor: string;
  cueColor: string;
}) {
  if (mode === "auto") {
    return (
      <>
        <Silhouette color={shapeColor} />
        {/* Face-tracking cue — corner brackets around the head, distinguishing
            Auto from Center's static crosshair below. */}
        <CornerBrackets top="4px" left="14px" size="28px" color={cueColor} />
      </>
    );
  }

  if (mode === "center") {
    return (
      <>
        <Silhouette color={shapeColor} />
        {/* Center-guide cue — a static crosshair through the tile midpoint. */}
        <Box position="absolute" top="0" left="50%" w="1px" h="100%" bg={cueColor} opacity={0.5} />
        <Box position="absolute" left="0" top="50%" w="100%" h="1px" bg={cueColor} opacity={0.5} />
      </>
    );
  }

  // "fit": the letterboxed video sits inside the tile with visible bands
  // above/below (the tile's own background stands in for the bands).
  return (
    <Box
      position="absolute"
      top="50%"
      left="50%"
      transform="translate(-50%, -50%)"
      w="44px"
      h="25px"
      borderRadius="l1"
      bg="studio.surface"
      borderWidth="1px"
      borderColor="studio.borderStrong"
      overflow="hidden"
    >
      <Box position="absolute" top="3px" left="50%" transform="translateX(-50%)" w="8px" h="8px" borderRadius="full" bg={shapeColor} />
      <Box
        position="absolute"
        bottom="2px"
        left="50%"
        transform="translateX(-50%)"
        w="16px"
        h="10px"
        bg={shapeColor}
        css={{ borderTopLeftRadius: "4px", borderTopRightRadius: "4px" }}
      />
    </Box>
  );
}

function FramingPresetTile({
  id,
  label,
  isActive,
  onClick,
}: {
  id: EffectiveFramingMode;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <Flex direction="column" align="center" gap="6px">
      <Box
        as="button"
        aria-label={label}
        aria-pressed={isActive}
        title={label}
        onClick={onClick}
        w="56px"
        h="84px"
        position="relative"
        overflow="hidden"
        borderRadius="l2"
        borderWidth="2px"
        borderColor={isActive ? "studio.ring" : "studio.border"}
        bg={isActive ? "studio.raised" : "studio.subtle"}
        cursor="pointer"
        flexShrink={0}
        transition="background 120ms ease, border-color 120ms ease"
        _hover={{ borderColor: isActive ? "studio.ring" : "studio.borderStrong" }}
      >
        <FramingPresetArt
          mode={id}
          shapeColor={isActive ? "studio.fg" : "studio.fgSubtle"}
          cueColor={isActive ? "studio.accentFg" : "studio.fgMuted"}
        />
      </Box>
      <Text
        fontSize="11px"
        color={isActive ? "studio.accentFg" : "studio.fgMuted"}
        fontWeight={isActive ? "600" : "500"}
        textAlign="center"
      >
        {label}
      </Text>
    </Flex>
  );
}

export function FramingPresetGrid({
  selected,
  onSelect,
}: {
  selected: EffectiveFramingMode;
  onSelect: (mode: EffectiveFramingMode) => void;
}) {
  return (
    <Box display="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: "8px" }}>
      {FRAMING_PRESETS.map((preset) => (
        <FramingPresetTile
          key={preset.id}
          id={preset.id}
          label={preset.label}
          isActive={selected === preset.id}
          onClick={() => onSelect(preset.id)}
        />
      ))}
    </Box>
  );
}
