"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Textarea, Slider } from "@chakra-ui/react";
import { Plus, X } from "lucide-react";
import { useStudio } from "../studio-shell";

// Preview styles mirror the USER text-layer colors that get burned in —
// they intentionally stay literal.
const PRESETS = [
  { id: "lower-third",  label: "Lower Third",  preview: "Name / Title",     style: { fontSize: "11px", fontWeight: "600", color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.8)" } },
  { id: "title-card",   label: "Title Card",   preview: "BIG TITLE",        style: { fontSize: "14px", fontWeight: "900", color: "#fff", letterSpacing: "0.08em" } },
  { id: "minimal",      label: "Minimal",      preview: "subtitle text",    style: { fontSize: "11px", color: "#ccc", letterSpacing: "0.1em" } },
  { id: "bold-callout", label: "Bold Callout", preview: "KEY POINT",        style: { fontSize: "13px", fontWeight: "900", color: "#00ff88" } },
  { id: "quote",        label: "Quote",        preview: '"Inspiring quote"', style: { fontSize: "11px", color: "#fbbf24", fontStyle: "italic" } },
  { id: "caption",      label: "Caption",      preview: "Description text", style: { fontSize: "11px", color: "#aaa" } },
];

export function TextPanel() {
  const { studioEdits, setStudioEdits, playbackClock, duration } = useStudio();
  const [activeTab, setActiveTab] = useState<"presets" | "custom">("presets");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [customText, setCustomText] = useState("");
  const [fontSize, setFontSize] = useState(44);

  const addLayer = (input: {
    text: string;
    fontSize?: number;
    color?: string;
    positionY?: number;
    bold?: boolean;
  }) => {
    const text = input.text.trim();
    if (!text) return;
    const startSec = Math.max(0, playbackClock.getSnapshot());
    const endSec = Math.min(duration, startSec + 6);
    setStudioEdits((prev) => ({
      ...prev,
      textLayers: [
        ...prev.textLayers,
        {
          id: crypto.randomUUID(),
          text,
          startSec,
          endSec: endSec > startSec + 0.5 ? endSec : null,
          positionX: 50,
          positionY: input.positionY ?? 18,
          fontName: "Arial",
          fontSize: input.fontSize ?? 44,
          color: input.color ?? "#FFFFFF",
          backgroundColor: null,
          backgroundOpacity: 0.72,
          bold: input.bold ?? true,
          outlineColor: "#000000",
          outlineWidth: 2,
        },
      ],
    }));
  };

  const removeLayer = (id: string) => {
    setStudioEdits((prev) => ({
      ...prev,
      textLayers: prev.textLayers.filter((layer) => layer.id !== id),
    }));
  };

  return (
    <Stack gap="0">
      {/* Tabs */}
      <Flex px="12px" pt="12px" gap="4px" mb="12px" role="tablist" aria-label="Text overlays">
        {(["presets", "custom"] as const).map((tab) => {
          const isActive = activeTab === tab;
          return (
            <Flex
              key={tab}
              as="button"
              role="tab"
              aria-selected={isActive}
              align="center"
              px="12px"
              py="6px"
              borderRadius="l2"
              bg={isActive ? "studio.raised" : "transparent"}
              border="1px solid"
              borderColor={isActive ? "studio.borderStrong" : "transparent"}
              color={isActive ? "studio.fg" : "studio.fgMuted"}
              cursor="pointer"
              fontSize="12px"
              fontWeight="500"
              onClick={() => setActiveTab(tab)}
              transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
              textTransform="capitalize"
            >
              {tab}
            </Flex>
          );
        })}
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
              borderRadius="l2"
              bg={selectedPreset === p.id ? "studio.raised" : "studio.subtle"}
              border="1px solid"
              borderColor={selectedPreset === p.id ? "studio.accent" : "studio.border"}
              cursor="pointer"
              onClick={() => setSelectedPreset(selectedPreset === p.id ? null : p.id)}
              transition="background 120ms ease, border-color 120ms ease"
              _hover={{ borderColor: selectedPreset === p.id ? "studio.accent" : "studio.borderStrong" }}
            >
              <Box>
                <Text fontSize="11px" color="studio.fgMuted" mb="3px" fontWeight="500">{p.label}</Text>
                <Text style={p.style}>{p.preview}</Text>
              </Box>
              <Box
                as="button"
                aria-label={`Add ${p.label} overlay`}
                w="26px"
                h="26px"
                borderRadius="full"
                bg="studio.raised"
                borderWidth="1px"
                borderColor="studio.borderStrong"
                display="flex"
                alignItems="center"
                justifyContent="center"
                cursor="pointer"
                color="studio.fgMuted"
                _hover={{ borderColor: "studio.accent", color: "studio.accentFg" }}
                transition="border-color 120ms ease, color 120ms ease"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  addLayer({
                    text: p.preview,
                    fontSize: p.id === "title-card" ? 62 : 42,
                    color:
                      p.id === "bold-callout"
                        ? "#00FF88"
                        : p.id === "quote"
                          ? "#FBBF24"
                          : "#FFFFFF",
                    positionY: p.id === "lower-third" ? 76 : 18,
                    bold: p.id !== "minimal",
                  });
                }}
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
            <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">Text content</Text>
            <Textarea
              placeholder="Type your text..."
              value={customText}
              onChange={(event) => setCustomText(event.target.value)}
              rows={3}
              size="sm"
              variant="outline"
              fontSize="12px"
              bg="studio.subtle"
              borderColor="studio.borderControl"
              color="studio.fg"
              _placeholder={{ color: "studio.fgSubtle" }}
              _focusVisible={{ borderColor: "studio.ring", boxShadow: "none" }}
              resize="vertical"
            />
          </Box>
          <Box>
            <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">Font size</Text>
            <Flex align="center" gap="10px">
              <Slider.Root
                aria-label={["Font size"]}
                value={[fontSize]}
                min={12}
                max={80}
                onValueChange={(event) => setFontSize(event.value[0] ?? 44)}
                size="sm"
                colorPalette="accent"
                flex="1"
              >
                <Slider.Control>
                  <Slider.Track>
                    <Slider.Range />
                  </Slider.Track>
                  <Slider.Thumbs />
                </Slider.Control>
              </Slider.Root>
              <Text textStyle="data" fontSize="12px" color="studio.fgMuted" w="24px" textAlign="right">
                {fontSize}
              </Text>
            </Flex>
          </Box>
          {/* Secondary action — Export owns the view's solid button */}
          <Flex
            as="button"
            align="center"
            justify="center"
            h="34px"
            borderRadius="l2"
            bg="studio.raised"
            borderWidth="1px"
            borderColor="studio.borderStrong"
            color="studio.fg"
            fontSize="12px"
            fontWeight="600"
            cursor="pointer"
            gap="6px"
            _hover={{ borderColor: "studio.fgSubtle" }}
            transition="border-color 120ms ease"
            onClick={() => {
              addLayer({ text: customText, fontSize });
              setCustomText("");
            }}
          >
            <Plus size={14} />
            Add text overlay
          </Flex>
        </Stack>
      )}

      {studioEdits.textLayers.length > 0 && (
        <Box px="12px" pb="12px">
          <Text textStyle="eyebrow" color="studio.fgMuted" mb="8px">
            Layers
          </Text>
          <Stack gap="4px">
            {studioEdits.textLayers.map((layer) => (
              <Flex
                key={layer.id}
                align="center"
                justify="space-between"
                px="10px"
                py="8px"
                borderRadius="l2"
                bg="studio.subtle"
                borderWidth="1px"
                borderColor="studio.border"
              >
                <Box minW="0">
                  <Text fontSize="11px" color="studio.fg" overflow="hidden" whiteSpace="nowrap" textOverflow="ellipsis">
                    {layer.text}
                  </Text>
                  <Text textStyle="data" fontSize="10.5px" color="studio.timecode">
                    {layer.startSec.toFixed(1)}s – {layer.endSec ? `${layer.endSec.toFixed(1)}s` : "end"}
                  </Text>
                </Box>
                <Box
                  as="button"
                  aria-label="Remove text layer"
                  color="studio.fgMuted"
                  p="4px"
                  cursor="pointer"
                  _hover={{ color: "danger.400" }}
                  transition="color 120ms ease"
                  onClick={() => removeLayer(layer.id)}
                >
                  <X size={13} />
                </Box>
              </Flex>
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
