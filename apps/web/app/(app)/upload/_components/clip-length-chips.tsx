"use client";

import { chakra, Flex } from "@chakra-ui/react";
import type { ClipLengthPreset } from "@narriflow/validators";

const OPTIONS: { value: ClipLengthPreset; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "under_30s", label: "<30s" },
  { value: "30_to_60s", label: "30–60s" },
  { value: "60_to_120s", label: "1–2m" },
  { value: "120_to_180s", label: "2–3m" },
];

/** Single-select chip row — a visual upgrade of the plain preset select,
 *  same underlying semantics (clipLengthPresetRanges). */
export function ClipLengthChips({
  value,
  onChange,
}: {
  value: ClipLengthPreset;
  onChange: (value: ClipLengthPreset) => void;
}) {
  return (
    <Flex gap="2" wrap="wrap" role="radiogroup" aria-label="Clip length">
      {OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <chakra.button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            px="3.5"
            py="1.5"
            borderRadius="l2"
            borderWidth="1px"
            borderColor={active ? "accent.solid" : "border.control"}
            bg={active ? "accent.subtle" : "bg.subtle"}
            color={active ? "accent.fg" : "fg.muted"}
            fontSize="12.5px"
            fontWeight="500"
            cursor="pointer"
            transition="border-color 120ms ease, background 120ms ease, color 120ms ease"
            _hover={{
              borderColor: active ? "accent.solid" : "border.emphasized",
              color: active ? "accent.fg" : "fg",
            }}
          >
            {option.label}
          </chakra.button>
        );
      })}
    </Flex>
  );
}
