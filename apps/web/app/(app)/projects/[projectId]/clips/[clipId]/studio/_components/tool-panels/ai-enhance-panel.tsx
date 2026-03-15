"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Switch } from "@chakra-ui/react";
import { Sparkles, Zap } from "lucide-react";

interface EnhanceSetting {
  id: string;
  label: string;
  description: string;
  cost: number;
  options?: string[];
  selectedOption?: string;
}

const SETTINGS: EnhanceSetting[] = [
  {
    id: "reframe",
    label: "Auto reframe",
    description: "Keeps subject centered using AI tracking",
    cost: 2,
    options: ["Off", "Auto", "Face focus", "Action"],
    selectedOption: "Off",
  },
  {
    id: "color",
    label: "Color grade",
    description: "Applies cinematic color grading",
    cost: 1,
    options: ["Off", "Cinematic", "Vivid", "B&W", "Warm", "Cool"],
    selectedOption: "Off",
  },
  {
    id: "noise",
    label: "Noise reduction",
    description: "Removes grain and reduces video noise",
    cost: 1,
  },
  {
    id: "stabilize",
    label: "Stabilization",
    description: "Reduces camera shake and jitter",
    cost: 2,
  },
  {
    id: "brightness",
    label: "Auto brightness",
    description: "Intelligently adjusts exposure and contrast",
    cost: 0,
  },
];

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={(e) => onChange(e.checked)}
      size="sm"
      colorPalette="purple"
      flexShrink={0}
    >
      <Switch.HiddenInput />
      <Switch.Control>
        <Switch.Thumb />
      </Switch.Control>
    </Switch.Root>
  );
}

export function AiEnhancePanel() {
  const [toggles, setToggles] = useState<Record<string, boolean>>({
    reframe: false, color: false, noise: false, stabilize: false, brightness: false,
  });
  const [options, setOptions] = useState<Record<string, string>>(
    Object.fromEntries(
      SETTINGS.filter((s) => s.options).map((s) => [s.id, s.selectedOption ?? s.options![0]!]),
    ),
  );

  const totalCost = SETTINGS.reduce(
    (sum, s) => sum + (toggles[s.id] ? s.cost : 0),
    0,
  );

  return (
    <Stack gap="0" h="100%">
      <Stack gap="2px" p="12px" flex="1">
        {SETTINGS.map((s) => (
          <Box
            key={s.id}
            px="12px"
            py="12px"
            borderRadius="8px"
            bg="#161616"
            border="1px solid #1e1e1e"
          >
            <Flex align="center" justify="space-between" mb={s.options && toggles[s.id] ? "8px" : "0"}>
              <Box flex="1" pr="12px">
                <Flex align="center" gap="6px">
                  <Text fontSize="12px" fontWeight="500" color="#ccc">{s.label}</Text>
                  {s.cost > 0 && (
                    <Flex align="center" gap="2px">
                      <Zap size={9} color="#f59e0b" fill="#f59e0b" />
                      <Text fontSize="9px" color="#a36a00">{s.cost}</Text>
                    </Flex>
                  )}
                </Flex>
                <Text fontSize="10px" color="#555" mt="2px">{s.description}</Text>
              </Box>
              <Toggle
                checked={toggles[s.id] ?? false}
                onChange={(v) => setToggles((prev) => ({ ...prev, [s.id]: v }))}
              />
            </Flex>

            {/* Sub-option select */}
            {s.options && toggles[s.id] && (
              <Flex gap="4px" flexWrap="wrap">
                {s.options.filter((o) => o !== "Off").map((opt) => (
                  <Box
                    key={opt}
                    as="button"
                    px="8px"
                    py="3px"
                    borderRadius="99px"
                    bg={options[s.id] === opt ? "rgba(99,102,241,0.15)" : "#222"}
                    border="1px solid"
                    borderColor={options[s.id] === opt ? "#6366F1" : "#2a2a2a"}
                    color={options[s.id] === opt ? "#a5b4fc" : "#666"}
                    fontSize="10px"
                    cursor="pointer"
                    onClick={() => setOptions((prev) => ({ ...prev, [s.id]: opt }))}
                    transition="all 150ms"
                  >
                    {opt}
                  </Box>
                ))}
              </Flex>
            )}
          </Box>
        ))}
      </Stack>

      {/* Apply */}
      <Box p="12px" borderTopWidth="1px" borderColor="#1e1e1e">
        {totalCost > 0 && (
          <Flex align="center" gap="4px" justify="center" mb="8px">
            <Zap size={12} color="#f59e0b" fill="#f59e0b" />
            <Text fontSize="11px" color="#a36a00">
              This will use {totalCost} credit{totalCost !== 1 ? "s" : ""}
            </Text>
          </Flex>
        )}
        <Flex
          as="button"
          align="center"
          justify="center"
          h="36px"
          borderRadius="8px"
          bg="#6366F1"
          color="white"
          fontSize="12px"
          fontWeight="600"
          cursor="pointer"
          gap="6px"
          w="100%"
          _hover={{ bg: "#4F46E5" }}
          transition="background 150ms"
        >
          <Sparkles size={14} />
          Apply AI enhance
        </Flex>
      </Box>
    </Stack>
  );
}
