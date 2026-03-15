"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Slider, ColorPicker, HStack, Portal, parseColor } from "@chakra-ui/react";
import { Upload, LayoutGrid } from "lucide-react";

const POSITION_GRID = [
  ["top-left", "top-center", "top-right"],
  ["mid-left", "center",     "mid-right"],
  ["bot-left", "bot-center", "bot-right"],
];

const BRAND_PRESETS = [
  { id: "minimal",   label: "Minimal",   accent: "#6366F1" },
  { id: "bold",      label: "Bold",      accent: "#f59e0b" },
  { id: "dark",      label: "Dark",      accent: "#1a1a1a" },
  { id: "vibrant",   label: "Vibrant",   accent: "#ec4899" },
];

export function BrandTemplatePanel() {
  const [logoPos, setLogoPos] = useState("bot-right");
  const [opacity, setOpacity] = useState(80);
  const [primaryColor, setPrimaryColor] = useState("#6366F1");
  const [secondaryColor, setSecondaryColor] = useState("#0c0c0c");

  return (
    <Stack gap="16px" p="12px">
      {/* Logo upload */}
      <Box>
        <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em" mb="8px">
          Logo / Watermark
        </Text>
        <Flex
          direction="column"
          align="center"
          justify="center"
          h="80px"
          borderRadius="8px"
          border="2px dashed #2a2a2a"
          bg="#111"
          cursor="pointer"
          gap="6px"
          color="#444"
          transition="all 150ms"
          _hover={{ bg: "#161616", borderColor: "#3a3a3a", color: "#666" }}
        >
          <Upload size={18} />
          <Text fontSize="11px">Upload logo (PNG, SVG)</Text>
        </Flex>
      </Box>

      {/* Watermark position */}
      <Box>
        <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em" mb="8px">
          Position
        </Text>
        <Box
          display="inline-grid"
          style={{ gridTemplateColumns: "repeat(3, 32px)", gap: "4px" }}
        >
          {POSITION_GRID.flat().map((pos) => (
            <Box
              key={pos}
              w="32px"
              h="32px"
              borderRadius="5px"
              bg={logoPos === pos ? "rgba(99,102,241,0.2)" : "#1a1a1a"}
              border="1px solid"
              borderColor={logoPos === pos ? "#6366F1" : "#2a2a2a"}
              cursor="pointer"
              onClick={() => setLogoPos(pos)}
              transition="all 150ms"
              _hover={{ borderColor: "#444" }}
            />
          ))}
        </Box>
      </Box>

      {/* Opacity */}
      <Box>
        <Flex align="center" justify="space-between" mb="6px">
          <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em">
            Opacity
          </Text>
          <Text fontSize="11px" color="#888" fontFamily="mono">{opacity}%</Text>
        </Flex>
        <Slider.Root
          value={[opacity]}
          min={10}
          max={100}
          onValueChange={(e) => setOpacity(e.value[0]!)}
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

      {/* Brand colors */}
      <Box>
        <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em" mb="8px">
          Brand colors
        </Text>
        <Flex gap="12px">
          <Box>
            <Text fontSize="10px" color="#555" mb="5px">Primary</Text>
            <ColorPicker.Root
              value={parseColor(primaryColor)}
              onValueChange={(e) => setPrimaryColor(e.value.toString("hex"))}
              size="xs"
            >
              <ColorPicker.HiddenInput />
              <ColorPicker.Control>
                <ColorPicker.Trigger w="32px" h="32px" borderRadius="6px" border="1px solid #2a2a2a" cursor="pointer" p="2px">
                  <ColorPicker.ValueSwatch w="100%" h="100%" borderRadius="4px" />
                </ColorPicker.Trigger>
              </ColorPicker.Control>
              <Portal>
                <ColorPicker.Positioner>
                  <ColorPicker.Content>
                    <ColorPicker.Area />
                    <HStack>
                      <ColorPicker.EyeDropper size="xs" variant="outline" />
                      <ColorPicker.Sliders />
                    </HStack>
                  </ColorPicker.Content>
                </ColorPicker.Positioner>
              </Portal>
            </ColorPicker.Root>
          </Box>
          <Box>
            <Text fontSize="10px" color="#555" mb="5px">Secondary</Text>
            <ColorPicker.Root
              value={parseColor(secondaryColor)}
              onValueChange={(e) => setSecondaryColor(e.value.toString("hex"))}
              size="xs"
            >
              <ColorPicker.HiddenInput />
              <ColorPicker.Control>
                <ColorPicker.Trigger w="32px" h="32px" borderRadius="6px" border="1px solid #2a2a2a" cursor="pointer" p="2px">
                  <ColorPicker.ValueSwatch w="100%" h="100%" borderRadius="4px" />
                </ColorPicker.Trigger>
              </ColorPicker.Control>
              <Portal>
                <ColorPicker.Positioner>
                  <ColorPicker.Content>
                    <ColorPicker.Area />
                    <HStack>
                      <ColorPicker.EyeDropper size="xs" variant="outline" />
                      <ColorPicker.Sliders />
                    </HStack>
                  </ColorPicker.Content>
                </ColorPicker.Positioner>
              </Portal>
            </ColorPicker.Root>
          </Box>
        </Flex>
      </Box>

      {/* Preset templates */}
      <Box>
        <Text fontSize="10px" color="#555" fontWeight="600" textTransform="uppercase" letterSpacing="0.07em" mb="8px">
          Quick presets
        </Text>
        <Flex gap="6px" flexWrap="wrap">
          {BRAND_PRESETS.map((p) => (
            <Flex
              key={p.id}
              as="button"
              align="center"
              gap="6px"
              px="10px"
              py="6px"
              borderRadius="6px"
              bg="#1a1a1a"
              border="1px solid #2a2a2a"
              cursor="pointer"
              fontSize="11px"
              color="#888"
              transition="all 150ms"
              _hover={{ bg: "#1e1e1e", borderColor: "#333" }}
              onClick={() => setPrimaryColor(p.accent)}
            >
              <Box w="10px" h="10px" borderRadius="full" bg={p.accent} />
              {p.label}
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
        <LayoutGrid size={14} />
        Apply brand template
      </Flex>
    </Stack>
  );
}
