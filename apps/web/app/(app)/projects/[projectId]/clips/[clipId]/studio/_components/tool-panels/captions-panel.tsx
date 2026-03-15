"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Slider, ColorPicker, HStack, Portal, parseColor } from "@chakra-ui/react";
import { Bold, Droplet, Type, AlignCenter, MoveUp, MoveDown, Zap } from "lucide-react";
import { useStudio } from "../studio-shell";

const FONTS = [
  "Bebas Neue", "Impact", "Arial", "Roboto",
  "Montserrat", "Oswald", "Open Sans",
];

const ANIMATIONS = [
  { id: "none",        label: "None" },
  { id: "word-by-word", label: "Word by word" },
  { id: "karaoke",     label: "Karaoke" },
  { id: "bounce",      label: "Bounce" },
];

type Position = "top" | "center" | "bottom";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text fontSize="10px" fontWeight="600" color="#555" textTransform="uppercase" letterSpacing="0.07em" mb="8px">
      {children}
    </Text>
  );
}

function ToggleBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Flex
      as="button"
      direction="column"
      align="center"
      justify="center"
      gap="4px"
      w="52px"
      h="44px"
      borderRadius="8px"
      bg={active ? "rgba(99,102,241,0.15)" : "#1e1e1e"}
      border="1px solid"
      borderColor={active ? "#6366F1" : "#2a2a2a"}
      color={active ? "#a5b4fc" : "#666"}
      cursor="pointer"
      fontSize="9px"
      fontWeight="600"
      onClick={onClick}
      transition="all 150ms"
      _hover={{ borderColor: "#3a3a3a", color: "#aaa" }}
    >
      {icon}
      {label}
    </Flex>
  );
}

export function CaptionsPanel() {
  const { captionPreset, setCaptionPreset } = useStudio();

  const update = (patch: Partial<typeof captionPreset>) =>
    setCaptionPreset((p) => ({ ...p, ...patch }));

  const [localAnimation, setLocalAnimation] = useState(
    captionPreset.animation ?? "word-by-word",
  );

  return (
    <Stack gap="0">
      {/* Caption preview */}
      <Box
        mx="12px"
        mt="12px"
        mb="0"
        h="80px"
        borderRadius="8px"
        bg="#000"
        overflow="hidden"
        position="relative"
        border="1px solid #2a2a2a"
      >
        <Box
          position="absolute"
          bottom="16px"
          left="0"
          right="0"
          textAlign="center"
        >
          <Text
            fontSize="22px"
            fontWeight="900"
            textTransform="uppercase"
            style={{
              fontFamily: `"${captionPreset.fontName}", Impact, sans-serif`,
              color: captionPreset.primaryColor,
              textShadow: captionPreset.shadow
                ? "0 2px 6px rgba(0,0,0,0.9), -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000"
                : "none",
              letterSpacing: "0.04em",
            }}
          >
            PREVIEW{" "}
            <Box as="span" style={{ color: captionPreset.highlightColor ?? "#00ff88" }}>
              TEXT
            </Box>
          </Text>
        </Box>
      </Box>

      <Stack gap="16px" p="12px">
        {/* Font */}
        <Box>
          <SectionLabel>Font</SectionLabel>
          <Box
            overflowX="auto"
            pb="4px"
            css={{
              "&::-webkit-scrollbar": { height: "3px" },
              "&::-webkit-scrollbar-thumb": { background: "#2a2a2a", borderRadius: "4px" },
            }}
          >
            <Flex gap="6px" w="max-content">
              {FONTS.map((f) => (
                <Box
                  key={f}
                  as="button"
                  px="10px"
                  py="6px"
                  borderRadius="6px"
                  bg={captionPreset.fontName === f ? "rgba(99,102,241,0.15)" : "#1a1a1a"}
                  border="1px solid"
                  borderColor={captionPreset.fontName === f ? "#6366F1" : "#2a2a2a"}
                  cursor="pointer"
                  onClick={() => update({ fontName: f })}
                  whiteSpace="nowrap"
                  transition="all 150ms"
                  _hover={{ borderColor: "#3a3a3a" }}
                >
                  <Text
                    fontSize="12px"
                    color={captionPreset.fontName === f ? "#a5b4fc" : "#888"}
                    style={{ fontFamily: `"${f}", sans-serif` }}
                  >
                    {f}
                  </Text>
                </Box>
              ))}
            </Flex>
          </Box>
        </Box>

        {/* Style toggles */}
        <Box>
          <SectionLabel>Style</SectionLabel>
          <Flex gap="6px">
            <ToggleBtn
              icon={<Bold size={14} />}
              label="Bold"
              active={captionPreset.bold}
              onClick={() => update({ bold: !captionPreset.bold })}
            />
            <ToggleBtn
              icon={<Droplet size={14} />}
              label="Shadow"
              active={captionPreset.shadow === 1}
              onClick={() => update({ shadow: captionPreset.shadow ? 0 : 1 })}
            />
            <ToggleBtn
              icon={<Type size={14} />}
              label="Outline"
              active={captionPreset.outlineWidth > 0}
              onClick={() => update({ outlineWidth: captionPreset.outlineWidth > 0 ? 0 : 2 })}
            />
          </Flex>
        </Box>

        {/* Colors */}
        <Box>
          <SectionLabel>Colors</SectionLabel>
          <Flex gap="12px">
            <Box>
              <Text fontSize="10px" color="#555" mb="5px">Text</Text>
              <ColorPicker.Root
                value={parseColor(captionPreset.primaryColor)}
                onValueChange={(e) => update({ primaryColor: e.value.toString("hex") })}
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
              <Text fontSize="10px" color="#555" mb="5px">Highlight</Text>
              <ColorPicker.Root
                value={parseColor(captionPreset.highlightColor ?? "#00ff88")}
                onValueChange={(e) => update({ highlightColor: e.value.toString("hex") })}
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
              <Text fontSize="10px" color="#555" mb="5px">Outline</Text>
              <ColorPicker.Root
                value={parseColor(captionPreset.outlineColor)}
                onValueChange={(e) => update({ outlineColor: e.value.toString("hex") })}
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

        {/* Outline width */}
        <Box>
          <SectionLabel>Outline width</SectionLabel>
          <Flex align="center" gap="10px">
            <Slider.Root
              value={[captionPreset.outlineWidth]}
              min={0}
              max={4}
              step={1}
              onValueChange={(e) => update({ outlineWidth: e.value[0]! })}
              size="sm"
              colorPalette="purple"
              flex="1"
            >
              <Slider.Control>
                <Slider.Track>
                  <Slider.Range />
                </Slider.Track>
                <Slider.Thumbs />
              </Slider.Control>
            </Slider.Root>
            <Text fontSize="12px" color="#888" fontFamily="mono" w="16px">
              {captionPreset.outlineWidth}
            </Text>
          </Flex>
        </Box>

        {/* Position */}
        <Box>
          <SectionLabel>Position</SectionLabel>
          <Flex gap="6px">
            {(["top", "center", "bottom"] as Position[]).map((pos) => (
              <ToggleBtn
                key={pos}
                icon={
                  pos === "top" ? <MoveUp size={14} /> :
                  pos === "center" ? <AlignCenter size={14} /> :
                  <MoveDown size={14} />
                }
                label={pos.charAt(0).toUpperCase() + pos.slice(1)}
                active={captionPreset.position === pos}
                onClick={() => update({ position: pos })}
              />
            ))}
          </Flex>
        </Box>

        {/* Animation */}
        <Box>
          <SectionLabel>Animation</SectionLabel>
          <Stack gap="4px">
            {ANIMATIONS.map((anim) => (
              <Flex
                key={anim.id}
                as="button"
                align="center"
                gap="8px"
                px="10px"
                py="8px"
                borderRadius="6px"
                bg={localAnimation === anim.id ? "rgba(99,102,241,0.1)" : "transparent"}
                border="1px solid"
                borderColor={localAnimation === anim.id ? "#6366F1" : "transparent"}
                cursor="pointer"
                onClick={() => {
                  setLocalAnimation(anim.id as typeof localAnimation);
                  update({ animation: anim.id as typeof localAnimation });
                }}
                transition="all 150ms"
                _hover={{ bg: "#1a1a1a" }}
              >
                <Zap size={12} color={localAnimation === anim.id ? "#a5b4fc" : "#555"} />
                <Text fontSize="12px" color={localAnimation === anim.id ? "#a5b4fc" : "#888"}>
                  {anim.label}
                </Text>
              </Flex>
            ))}
          </Stack>
        </Box>

        {/* Apply button */}
        <Flex
          as="button"
          align="center"
          justify="center"
          h="36px"
          borderRadius="8px"
          bg="#6366F1"
          color="white"
          fontSize="13px"
          fontWeight="600"
          cursor="pointer"
          transition="background 150ms"
          _hover={{ bg: "#4F46E5" }}
        >
          Apply to all clips
        </Flex>
      </Stack>
    </Stack>
  );
}
