"use client";

import { Flex } from "@chakra-ui/react";
import { Scissors, FileText } from "lucide-react";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import type { GenerationMode } from "@narriflow/validators";

interface ModeTabsProps {
  value: GenerationMode;
  onChange: (mode: GenerationMode) => void;
}

const items = [
  {
    value: "clip",
    label: (
      <Flex align="center" gap="1.5" justify="center">
        <Scissors size={14} strokeWidth={1.75} />
        AI clipping
      </Flex>
    ),
  },
  {
    value: "caption_only",
    label: (
      <Flex align="center" gap="1.5" justify="center">
        <FileText size={14} strokeWidth={1.75} />
        Caption only
      </Flex>
    ),
  },
];

export function ModeTabs({ value, onChange }: ModeTabsProps) {
  return (
    <SegmentedControl
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as GenerationMode);
      }}
      size="md"
    />
  );
}
