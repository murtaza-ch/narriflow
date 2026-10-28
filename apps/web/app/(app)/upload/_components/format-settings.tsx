"use client";

import { Box, Grid, Text } from "@chakra-ui/react";
import { Sparkles } from "lucide-react";
import { Select } from "@narriflow/ui/components/select";
import {
  clipAspectRatioOptions,
  type ClipLengthPreset,
  type ContentPack,
} from "@narriflow/validators";

export function RatioIcon({ ratio }: { ratio: ContentPack["defaultAspectRatio"] }) {
  const dimensions = {
    "9:16": { width: "8px", height: "14px" },
    "1:1": { width: "11px", height: "11px" },
    "16:9": { width: "14px", height: "8px" },
    "4:5": { width: "10px", height: "13px" },
  }[ratio];

  return (
    <Box
      w={dimensions.width}
      h={dimensions.height}
      borderWidth="1.5px"
      borderColor="currentColor"
      rounded="2px"
    />
  );
}

/** Where each format is usually posted, said once in the open list. */
const RATIO_USE: Record<ContentPack["defaultAspectRatio"], string> = {
  "9:16": "Vertical · TikTok, Shorts, Reels",
  "1:1": "Square · feeds",
  "16:9": "Landscape · YouTube, the web",
  "4:5": "Portrait · Instagram and Facebook feeds",
};

const ratioItems = clipAspectRatioOptions.map((option) => ({
  value: option.value,
  label: option.value,
  description: RATIO_USE[option.value],
  icon: <RatioFrame ratio={option.value} />,
}));

/** Each format drawn to its real shape, in a fixed slot so the option text lines up. */
const RATIO_FRAME: Record<ContentPack["defaultAspectRatio"], { w: number; h: number }> = {
  "9:16": { w: 13, h: 22 },
  "1:1": { w: 19, h: 19 },
  "16:9": { w: 26, h: 15 },
  "4:5": { w: 17, h: 21 },
};

function RatioFrame({ ratio }: { ratio: ContentPack["defaultAspectRatio"] }) {
  const { w, h } = RATIO_FRAME[ratio];
  return (
    <Box w="32px" h="26px" display="flex" alignItems="center" justifyContent="center">
      <Box
        borderRadius="4px"
        bg="bg.muted"
        borderWidth="1.5px"
        borderColor="fg.subtle"
        transition="transform 160ms ease, background 160ms ease, border-color 160ms ease"
        style={{ width: `${w}px`, height: `${h}px` }}
        css={{
          "[data-highlighted] &, [data-state=checked] &": {
            bg: "accent.subtle",
            borderColor: "accent.fg",
            transform: "scale(1.1)",
          },
        }}
      />
    </Box>
  );
}

/** How long each preset runs, as one to four bars. */
const LENGTH_LEVEL: Record<Exclude<ClipLengthPreset, "auto">, number> = {
  under_30s: 1,
  "30_to_60s": 2,
  "60_to_120s": 3,
  "120_to_180s": 4,
};

/** Rising bars, filled to the preset's level; they rise again when the option is highlighted. */
function LengthBars({ preset }: { preset: Exclude<ClipLengthPreset, "auto"> }) {
  const level = LENGTH_LEVEL[preset];
  return (
    <Box w="32px" h="20px" display="flex" alignItems="flex-end" justifyContent="center" gap="2px">
      {[1, 2, 3, 4].map((bar) => (
        <Box
          key={bar}
          w="4px"
          borderRadius="2px"
          bg={bar <= level ? "accent.solid" : "bg.emphasized"}
          transformOrigin="bottom"
          transform="scaleY(0.7)"
          transition="transform 240ms cubic-bezier(0.22, 1, 0.36, 1)"
          style={{ height: `${6 + bar * 3}px`, transitionDelay: `${(bar - 1) * 50}ms` }}
          css={{ "[data-highlighted] &, [data-state=checked] &": { transform: "scaleY(1)" } }}
        />
      ))}
    </Box>
  );
}

export const clipLengthItems: Array<{ value: ClipLengthPreset; label: string; description: string; icon: React.ReactNode }> = [
  {
    value: "auto",
    label: "Auto",
    description: "Each clip fits its moment, usually 30–60s",
    icon: (
      <Box w="32px" display="flex" justifyContent="center" color="accent.fg">
        <Sparkles size={15} />
      </Box>
    ),
  },
  { value: "under_30s", label: "Under 30 seconds", description: "Quick hooks and punchlines", icon: <LengthBars preset="under_30s" /> },
  { value: "30_to_60s", label: "30 to 60 seconds", description: "Room for one full point", icon: <LengthBars preset="30_to_60s" /> },
  { value: "60_to_120s", label: "1 to 2 minutes", description: "A story with its setup and payoff", icon: <LengthBars preset="60_to_120s" /> },
  { value: "120_to_180s", label: "2 to 3 minutes", description: "Deep dives and complete answers", icon: <LengthBars preset="120_to_180s" /> },
];

function StartText({ children }: { children: string }) {
  return (
    <Text color="fg.muted" fontSize="13px" whiteSpace="nowrap">
      {children}
    </Text>
  );
}

export function FormatSettings({
  aspectRatio,
  onAspectRatioChange,
  clipLength,
  onClipLengthChange,
  showClipLength,
}: {
  aspectRatio: ContentPack["defaultAspectRatio"];
  onAspectRatioChange: (value: ContentPack["defaultAspectRatio"]) => void;
  clipLength: ClipLengthPreset;
  onClipLengthChange: (value: ClipLengthPreset) => void;
  showClipLength: boolean;
}) {
  return (
    <Grid
      templateColumns={{ base: "1fr", sm: showClipLength ? "1fr 1fr" : "1fr" }}
      gap="4"
    >
      <Select
        ariaLabel="Aspect ratio"
        items={ratioItems}
        value={aspectRatio}
        onValueChange={(value) =>
          onAspectRatioChange(value as ContentPack["defaultAspectRatio"])
        }
        startElement={<StartText>Ratio</StartText>}
        size="md"
        w="full"
      />
      {showClipLength && (
        <Select
          ariaLabel="Clip length"
          items={clipLengthItems}
          value={clipLength}
          onValueChange={(value) =>
            onClipLengthChange(value as ClipLengthPreset)
          }
          startElement={<StartText>Clip length</StartText>}
          size="md"
          w="full"
        />
      )}
    </Grid>
  );
}
