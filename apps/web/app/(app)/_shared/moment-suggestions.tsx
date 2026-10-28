"use client";

import { Flex } from "@chakra-ui/react";
import { ChoiceChip } from "./choice-chip";

/** Common asks, written the way the field's placeholder reads. */
const MOMENT_SUGGESTIONS = [
  { label: "Biggest lesson", text: "When the speaker shares their biggest lesson" },
  { label: "Funny moments", text: "Funny or surprising moments" },
  { label: "Bold claims", text: "Bold or controversial claims" },
  { label: "How-to tips", text: "Practical, step-by-step tips" },
  { label: "Personal stories", text: "Personal stories" },
] as const;

/** Under "Find a specific moment": one tap writes a common ask, another takes it back out. */
export function MomentSuggestions({
  value,
  onChange,
  maxLength = 500,
}: {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <Flex gap="1.5" wrap="wrap" mt="2">
      {MOMENT_SUGGESTIONS.map((moment) => {
        const added = value.toLowerCase().includes(moment.text.toLowerCase());
        return (
          <ChoiceChip
            key={moment.label}
            on={added}
            onToggle={() =>
              onChange(
                added
                  ? value
                      .split("\n")
                      .filter((line) => line.trim().toLowerCase() !== moment.text.toLowerCase())
                      .join("\n")
                  : (value.trim() ? `${value.trim()}\n${moment.text}` : moment.text).slice(0, maxLength),
              )
            }
          >
            {moment.label}
          </ChoiceChip>
        );
      })}
    </Flex>
  );
}
