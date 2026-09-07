"use client";

import { Box, Grid, Text } from "@chakra-ui/react";
import { Select } from "@narriflow/ui/components/select";
import {
  clipAspectRatioOptions,
  type ClipLengthPreset,
  type ContentPack,
} from "@narriflow/validators";

function RatioIcon({ ratio }: { ratio: ContentPack["defaultAspectRatio"] }) {
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

const ratioItems = clipAspectRatioOptions.map((option) => ({
  value: option.value,
  label: option.value,
  icon: <RatioIcon ratio={option.value} />,
}));

const clipLengthItems = [
  { value: "auto", label: "Auto" },
  { value: "under_30s", label: "Under 30 seconds" },
  { value: "30_to_60s", label: "30 to 60 seconds" },
  { value: "60_to_120s", label: "1 to 2 minutes" },
  { value: "120_to_180s", label: "2 to 3 minutes" },
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
