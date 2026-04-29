"use client";

import { Flex, SegmentGroup } from "@chakra-ui/react";
import { Scissors, FileText } from "lucide-react";
import type { GenerationMode } from "@narriflow/validators";

interface ModeTabsProps {
  value: GenerationMode;
  onChange: (mode: GenerationMode) => void;
}

const items: Array<{ value: GenerationMode; label: string; icon: React.ReactNode }> = [
  { value: "clip", label: "AI clipping", icon: <Scissors size={14} /> },
  { value: "caption_only", label: "Caption only", icon: <FileText size={14} /> },
];

export function ModeTabs({ value, onChange }: ModeTabsProps) {
  return (
    <SegmentGroup.Root
      value={value}
      onValueChange={(details) => {
        if (details.value) onChange(details.value as GenerationMode);
      }}
      size="md"
      width="100%"
    >
      <SegmentGroup.Indicator />
      <SegmentGroup.Items
        flex="1"
        items={items.map((item) => ({
          value: item.value,
          label: (
            <Flex align="center" gap="6px" justify="center">
              {item.icon}
              {item.label}
            </Flex>
          ),
        }))}
      />
    </SegmentGroup.Root>
  );
}
