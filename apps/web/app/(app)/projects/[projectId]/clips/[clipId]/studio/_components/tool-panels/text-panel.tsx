"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Textarea, Slider } from "@chakra-ui/react";
import { Plus } from "lucide-react";

const PRESETS = [
  { id: "lower-third",  label: "Lower Third",  preview: "Name / Title",     style: { fontSize: "10px", fontWeight: "600", color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.8)" } },
  { id: "title-card",   label: "Title Card",   preview: "BIG TITLE",        style: { fontSize: "14px", fontWeight: "900", color: "#fff", letterSpacing: "0.08em" } },
  { id: "minimal",      label: "Minimal",      preview: "subtitle text",    style: { fontSize: "9px", color: "#ccc", letterSpacing: "0.1em" } },
  { id: "bold-callout", label: "Bold Callout", preview: "KEY POINT",        style: { fontSize: "13px", fontWeight: "900", color: "#00ff88" } },
  { id: "quote",        label: "Quote",        preview: '"Inspiring quote"', style: { fontSize: "9px", color: "#fbbf24", fontStyle: "italic" } },
  { id: "caption",      label: "Caption",      preview: "Description text", style: { fontSize: "9px", color: "#aaa" } },
];

export function TextPanel() {
  const [activeTab, setActiveTab] = useState<"presets" | "custom">("presets");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  return (
    <Stack gap="0">
      {/* Tabs */}
      <Flex px="12px" pt="12px" gap="4px" mb="12px">
        {(["presets", "custom"] as const).map((tab) => (
          <Flex
            key={tab}
            as="button"
            align="center"
            px="12px"
            py="6px"
            borderRadius="6px"
            bg={activeTab === tab ? "#1e1e1e" : "transparent"}
            border="1px solid"
            borderColor={activeTab === tab ? "#2a2a2a" : "transparent"}
            color={activeTab === tab ? "#ccc" : "#555"}
            cursor="pointer"
            fontSize="12px"
            fontWeight="500"
            onClick={() => setActiveTab(tab)}
            transition="all 150ms"
            textTransform="capitalize"
          >
            {tab}
          </Flex>
        ))}
      </Flex>

      {activeTab === "presets" && (
        <Stack gap="6px" px="12px" pb="12px">
          {PRESETS.map((p) => (
            <Flex
              key={p.id}
              align="center"
              justify="space-between"
              px="12px"
              py="12px"
              borderRadius="8px"
              bg={selectedPreset === p.id ? "rgba(99,102,241,0.08)" : "#1a1a1a"}
              border="1px solid"
              borderColor={selectedPreset === p.id ? "#6366F1" : "#252525"}
              cursor="pointer"
              onClick={() => setSelectedPreset(selectedPreset === p.id ? null : p.id)}
              transition="all 150ms"
              _hover={{ bg: "#1e1e1e", borderColor: "#333" }}
            >
              <Box>
                <Text fontSize="10px" color="#555" mb="3px" fontWeight="500">{p.label}</Text>
                <Text style={p.style}>{p.preview}</Text>
              </Box>
              <Box
                as="button"
                w="26px"
                h="26px"
                borderRadius="full"
                bg="#2a2a2a"
                border="none"
                display="flex"
                alignItems="center"
                justifyContent="center"
                cursor="pointer"
                color="#888"
                _hover={{ bg: "#6366F1", color: "white" }}
                transition="all 150ms"
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              >
                <Plus size={12} />
              </Box>
            </Flex>
          ))}
        </Stack>
      )}

      {activeTab === "custom" && (
        <Stack gap="12px" px="12px" pb="12px">
          <Box>
            <Text fontSize="10px" color="#555" mb="6px" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em">Text content</Text>
            <Textarea
              placeholder="Type your text..."
              rows={3}
              size="sm"
              variant="outline"
              fontSize="12px"
              bg="#1a1a1a"
              borderColor="#2a2a2a"
              color="#ccc"
              _placeholder={{ color: "#555" }}
              _focusVisible={{ borderColor: "#6366F1", boxShadow: "none" }}
              resize="vertical"
            />
          </Box>
          <Box>
            <Text fontSize="10px" color="#555" mb="6px" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em">Font size</Text>
            <Slider.Root
              defaultValue={[32]}
              min={12}
              max={80}
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
            <Plus size={14} />
            Add text overlay
          </Flex>
        </Stack>
      )}
    </Stack>
  );
}
