"use client";

import { useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { X } from "lucide-react";
import { ChoiceChip } from "./choice-chip";

/** One tap adds a common tone to the free-text preference, or takes it out. */
const TONE_SUGGESTIONS = ["Concise", "Conversational", "Energetic", "Educational", "Funny", "Serious"];

function toneWords(value: string) {
  return value
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);
}

/**
 * Tone as chips over the same comma list the pipeline reads: suggestions
 * toggle, typed words become removable chips (Enter or a comma adds them).
 */
export function ToneChips({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState("");
  const tones = toneWords(value);
  const hasTone = (tone: string) => tones.some((word) => word.toLowerCase() === tone.toLowerCase());
  const presetTones = new Set(TONE_SUGGESTIONS.map((tone) => tone.toLowerCase()));
  // Words someone typed that aren't one of the suggestions, kept as their own chips.
  const ownTones = tones.filter((word) => !presetTones.has(word.toLowerCase()));
  const without = (tone: string) => tones.filter((word) => word.toLowerCase() !== tone.toLowerCase());
  const addOwn = (text: string = draft) => {
    const words = toneWords(text).filter((word) => !hasTone(word));
    if (words.length > 0) onChange([...tones, ...words].join(", "));
    setDraft("");
  };

  return (
    <Flex gap="1.5" wrap="wrap" align="center">
      {TONE_SUGGESTIONS.map((tone) => (
        <ChoiceChip
          key={tone}
          on={hasTone(tone)}
          onToggle={() => onChange((hasTone(tone) ? without(tone) : [...tones, tone.toLowerCase()]).join(", "))}
        >
          {tone}
        </ChoiceChip>
      ))}
      {ownTones.map((tone) => (
        <Flex key={tone} align="center" gap="1" h="7" ps="2.5" pe="1" borderRadius="full" bg="accent.subtle" color="accent.fg" fontSize="12px">
          {tone}
          <chakra.button
            type="button"
            aria-label={`Remove ${tone}`}
            onClick={() => onChange(without(tone).join(", "))}
            display="grid"
            placeItems="center"
            boxSize="5"
            borderRadius="full"
            cursor="pointer"
            _hover={{ bg: "accent.muted" }}
          >
            <X size={11} aria-hidden />
          </chakra.button>
        </Flex>
      ))}
      <chakra.input
        value={draft}
        onChange={(event) => {
          // A comma ends a word, like pressing Enter.
          if (event.target.value.includes(",")) addOwn(event.target.value);
          else setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          // Enter adds the word; it must never submit a surrounding form.
          if (event.key === "Enter") {
            event.preventDefault();
            addOwn();
          }
        }}
        onBlur={() => addOwn()}
        placeholder="Add your own"
        aria-label="Add a tone"
        h="7"
        w="120px"
        px="2.5"
        borderRadius="full"
        bg="transparent"
        outline="none"
        fontSize="12px"
        color="fg"
        _placeholder={{ color: "fg.subtle" }}
        _focus={{ bg: "bg.soft" }}
      />
    </Flex>
  );
}
