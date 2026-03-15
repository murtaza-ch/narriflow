"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Slider } from "@chakra-ui/react";
import { Zap } from "lucide-react";

const TRANSITIONS = [
  { id: "cut",    label: "Cut",       icon: "✂️" },
  { id: "fade",   label: "Fade",      icon: "🌫" },
  { id: "slide",  label: "Slide",     icon: "➡️" },
  { id: "zoom",   label: "Zoom",      icon: "🔍" },
  { id: "spin",   label: "Spin",      icon: "🔄" },
  { id: "glitch", label: "Glitch",    icon: "⚡" },
  { id: "dip",    label: "Dip White", icon: "🌟" },
  { id: "wipe",   label: "Wipe",      icon: "↔️" },
];

export function TransitionsPanel() {
  const [selected, setSelected] = useState("cut");
  const [duration, setDuration] = useState(0.4);
  const [applyTo, setApplyTo] = useState<"all" | "selected">("all");

  return (
    <Stack gap="16px" p="12px">
      {/* Transition grid */}
      <Box>
        <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em" mb="10px">
          Style
        </Text>
        <Box
          display="grid"
          style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: "6px" }}
        >
          {TRANSITIONS.map((t) => (
            <Flex
              key={t.id}
              as="button"
              direction="column"
              align="center"
              justify="center"
              gap="4px"
              py="12px"
              borderRadius="8px"
              bg={selected === t.id ? "rgba(99,102,241,0.12)" : "#1a1a1a"}
              border="1px solid"
              borderColor={selected === t.id ? "#6366F1" : "#252525"}
              cursor="pointer"
              onClick={() => setSelected(t.id)}
              transition="all 150ms"
              _hover={{ bg: "#1e1e1e", borderColor: "#333" }}
            >
              <Text fontSize="18px" lineHeight="1">{t.icon}</Text>
              <Text fontSize="9px" color={selected === t.id ? "#a5b4fc" : "#666"} fontWeight="500">
                {t.label}
              </Text>
            </Flex>
          ))}
        </Box>
      </Box>

      {/* Duration */}
      <Box>
        <Flex align="center" justify="space-between" mb="8px">
          <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em">
            Duration
          </Text>
          <Text fontSize="11px" color="#888" fontFamily="mono">{duration.toFixed(1)}s</Text>
        </Flex>
        <Slider.Root
          value={[duration]}
          min={0.1}
          max={1.5}
          step={0.05}
          onValueChange={(e) => setDuration(e.value[0]!)}
          size="sm"
          colorPalette="purple"
          w="100%"
        >
          <Slider.Control>
            <Slider.Track>
              <Slider.Range />
            </Slider.Track>
            <Slider.Thumbs />
          </Slider.Control>
        </Slider.Root>
        <Flex justify="space-between" mt="4px">
          <Text fontSize="10px" color="#444">0.1s</Text>
          <Text fontSize="10px" color="#444">1.5s</Text>
        </Flex>
      </Box>

      {/* Apply to */}
      <Box>
        <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em" mb="8px">
          Apply to
        </Text>
        <Flex gap="6px">
          {(["all", "selected"] as const).map((opt) => (
            <Flex
              key={opt}
              as="button"
              align="center"
              px="12px"
              py="7px"
              borderRadius="6px"
              bg={applyTo === opt ? "rgba(99,102,241,0.12)" : "#1a1a1a"}
              border="1px solid"
              borderColor={applyTo === opt ? "#6366F1" : "#252525"}
              color={applyTo === opt ? "#a5b4fc" : "#777"}
              cursor="pointer"
              fontSize="11px"
              fontWeight="500"
              onClick={() => setApplyTo(opt)}
              transition="all 150ms"
              textTransform="capitalize"
            >
              {opt === "all" ? "All cuts" : "Selected only"}
            </Flex>
          ))}
        </Flex>
      </Box>

      <Flex
        as="button"
        align="center"
        justify="center"
        h="34px"
        borderRadius="7px"
        bg="#6366F1"
        color="white"
        fontSize="12px"
        fontWeight="600"
        cursor="pointer"
        gap="6px"
        _hover={{ bg: "#4F46E5" }}
        transition="background 150ms"
      >
        <Zap size={13} />
        Apply transition
      </Flex>
    </Stack>
  );
}
