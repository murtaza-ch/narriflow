"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Slider, ColorPicker, HStack, Portal, parseColor, Grid } from "@chakra-ui/react";
import { Bold, Droplet, Type, AlignCenter, MoveUp, MoveDown, Zap } from "lucide-react";
import { useStudio } from "../studio-shell";
import { CAPTION_PRESETS } from "./caption-presets";
import { PresetCard } from "./preset-card";

const FONTS = [
  "Bebas Neue", "Impact", "Arial", "Roboto",
  "Montserrat", "Oswald", "Open Sans",
];

const ANIMATIONS = [
  { id: "none",            label: "None" },
  { id: "word-by-word",    label: "Word by word" },
  { id: "karaoke",         label: "Karaoke" },
  { id: "bounce",          label: "Bounce" },
  { id: "blur-in",         label: "Blur In" },
  { id: "grow",            label: "Grow" },
  { id: "breathe",         label: "Breathe" },
  { id: "soft-landing",    label: "Soft Landing" },
  { id: "glitch",          label: "Glitch" },
  { id: "seamless-bounce", label: "Seamless Bounce" },
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

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <Box>
      <Text fontSize="10px" color="#555" mb="5px">{label}</Text>
      <ColorPicker.Root
        value={parseColor(value)}
        onValueChange={(e) => onChange(e.value.toString("hex"))}
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
  );
}

// ─── Presets Grid ────────────────────────────────────────────────────────────

function PresetsGrid() {
  const { captionPreset, setCaptionPreset } = useStudio();

  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(() => {
    // Try to match current preset to a named one
    const match = CAPTION_PRESETS.find(
      (p) =>
        p.preset.fontName === captionPreset.fontName &&
        p.preset.animation === captionPreset.animation &&
        p.preset.primaryColor === captionPreset.primaryColor &&
        p.preset.highlightColor === captionPreset.highlightColor,
    );
    return match?.id ?? null;
  });

  const handleSelect = (presetId: string) => {
    const named = CAPTION_PRESETS.find((p) => p.id === presetId);
    if (!named) return;

    setSelectedPresetId(presetId);
    // Apply preset but preserve user's position and font size
    setCaptionPreset((prev) => ({
      ...named.preset,
      position: prev.position,
      positionX: prev.positionX,
      positionY: prev.positionY,
      fontSize: prev.fontSize,
    }));
  };

  return (
    <Grid templateColumns="1fr 1fr" gap="8px" px="12px" pb="12px">
      {CAPTION_PRESETS.map((p) => (
        <PresetCard
          key={p.id}
          namedPreset={p}
          isSelected={selectedPresetId === p.id}
          onClick={() => handleSelect(p.id)}
        />
      ))}
    </Grid>
  );
}

// ─── Customize Controls ──────────────────────────────────────────────────────

function CustomizeControls() {
  const { captionPreset, setCaptionPreset } = useStudio();

  const update = (patch: Partial<typeof captionPreset>) =>
    setCaptionPreset((p) => ({ ...p, ...patch }));

  const [localAnimation, setLocalAnimation] = useState(
    captionPreset.animation ?? "word-by-word",
  );

  return (
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
          <ColorField
            label="Text"
            value={captionPreset.primaryColor}
            onChange={(v) => update({ primaryColor: v })}
          />
          <ColorField
            label="Highlight"
            value={captionPreset.highlightColor ?? "#00ff88"}
            onChange={(v) => update({ highlightColor: v })}
          />
          <ColorField
            label="Outline"
            value={captionPreset.outlineColor}
            onChange={(v) => update({ outlineColor: v })}
          />
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

      {/* Font size */}
      <Box>
        <SectionLabel>Font size</SectionLabel>
        <Flex align="center" gap="10px">
          <Slider.Root
            value={[captionPreset.fontSize]}
            min={8}
            max={120}
            step={1}
            onValueChange={(e) => update({ fontSize: e.value[0]! })}
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
          <Text fontSize="12px" color="#888" fontFamily="mono" w="28px">
            {captionPreset.fontSize}
          </Text>
        </Flex>
      </Box>

      {/* Text transform */}
      <Box>
        <SectionLabel>Text transform</SectionLabel>
        <Flex gap="6px">
          {(["uppercase", "lowercase", "capitalize", "none"] as const).map((t) => (
            <Box
              key={t}
              as="button"
              px="8px"
              py="5px"
              borderRadius="6px"
              bg={(captionPreset.textTransform ?? "uppercase") === t ? "rgba(99,102,241,0.15)" : "#1e1e1e"}
              border="1px solid"
              borderColor={(captionPreset.textTransform ?? "uppercase") === t ? "#6366F1" : "#2a2a2a"}
              cursor="pointer"
              onClick={() => update({ textTransform: t })}
              transition="all 150ms"
              _hover={{ borderColor: "#3a3a3a" }}
            >
              <Text
                fontSize="10px"
                color={(captionPreset.textTransform ?? "uppercase") === t ? "#a5b4fc" : "#888"}
                textTransform="capitalize"
              >
                {t === "none" ? "None" : t.slice(0, 5)}
              </Text>
            </Box>
          ))}
        </Flex>
      </Box>

      {/* Position */}
      <Box>
        <SectionLabel>Position</SectionLabel>
        <Flex gap="6px">
          {(["top", "center", "bottom"] as Position[]).map((pos) => {
            const presetYMap = { top: 10, center: 50, bottom: 88 };
            const py = captionPreset.positionY ?? presetYMap[captionPreset.position];
            const px = captionPreset.positionX ?? 50;
            const isActive = Math.abs(px - 50) < 5 && Math.abs(py - presetYMap[pos]) < 5;

            return (
              <ToggleBtn
                key={pos}
                icon={
                  pos === "top" ? <MoveUp size={14} /> :
                  pos === "center" ? <AlignCenter size={14} /> :
                  <MoveDown size={14} />
                }
                label={pos.charAt(0).toUpperCase() + pos.slice(1)}
                active={isActive}
                onClick={() => update({
                  position: pos,
                  positionX: 50,
                  positionY: presetYMap[pos],
                })}
              />
            );
          })}
        </Flex>
        {captionPreset.positionX !== undefined && (
          <Flex gap="8px" mt="6px" align="center">
            <Text fontSize="10px" color="#555">
              X: {captionPreset.positionX.toFixed(1)}%
            </Text>
            <Text fontSize="10px" color="#555">
              Y: {captionPreset.positionY?.toFixed(1)}%
            </Text>
            <Box
              as="button"
              fontSize="10px"
              color="#6366F1"
              cursor="pointer"
              _hover={{ textDecoration: "underline" }}
              onClick={() => update({ positionX: undefined, positionY: undefined })}
            >
              Reset
            </Box>
          </Flex>
        )}
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

      {/* ── Advanced Styling ────────────────────────────────────────────── */}

      {/* Backdrop */}
      <Box>
        <SectionLabel>Backdrop</SectionLabel>
        <Flex gap="6px" align="center" mb="8px">
          <ToggleBtn
            icon={<Box w="14px" h="14px" bg="#555" borderRadius="2px" />}
            label={captionPreset.backgroundColor ? "On" : "Off"}
            active={!!captionPreset.backgroundColor}
            onClick={() =>
              update(
                captionPreset.backgroundColor
                  ? { backgroundColor: undefined, backgroundOpacity: undefined }
                  : { backgroundColor: "#000000", backgroundOpacity: 0.6 },
              )
            }
          />
          {captionPreset.backgroundColor && (
            <ColorField
              label="Color"
              value={captionPreset.backgroundColor}
              onChange={(v) => update({ backgroundColor: v })}
            />
          )}
        </Flex>
        {captionPreset.backgroundColor && (
          <Flex align="center" gap="10px">
            <Text fontSize="10px" color="#555" w="50px">Opacity</Text>
            <Slider.Root
              value={[captionPreset.backgroundOpacity ?? 0.6]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(e) => update({ backgroundOpacity: e.value[0]! })}
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
            <Text fontSize="10px" color="#888" fontFamily="mono" w="28px">
              {(captionPreset.backgroundOpacity ?? 0.6).toFixed(2)}
            </Text>
          </Flex>
        )}
      </Box>

      {/* Highlight Box */}
      <Box>
        <SectionLabel>Highlight box</SectionLabel>
        <Flex gap="6px" align="center" mb="8px">
          <ToggleBtn
            icon={<Box w="14px" h="14px" bg="#FACC15" borderRadius="2px" />}
            label={captionPreset.highlightBoxColor ? "On" : "Off"}
            active={!!captionPreset.highlightBoxColor}
            onClick={() =>
              update(
                captionPreset.highlightBoxColor
                  ? { highlightBoxColor: undefined, highlightBoxOpacity: undefined }
                  : { highlightBoxColor: "#FACC15", highlightBoxOpacity: 1.0 },
              )
            }
          />
          {captionPreset.highlightBoxColor && (
            <ColorField
              label="Color"
              value={captionPreset.highlightBoxColor}
              onChange={(v) => update({ highlightBoxColor: v })}
            />
          )}
        </Flex>
        {captionPreset.highlightBoxColor && (
          <Flex align="center" gap="10px">
            <Text fontSize="10px" color="#555" w="50px">Opacity</Text>
            <Slider.Root
              value={[captionPreset.highlightBoxOpacity ?? 1.0]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(e) => update({ highlightBoxOpacity: e.value[0]! })}
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
            <Text fontSize="10px" color="#888" fontFamily="mono" w="28px">
              {(captionPreset.highlightBoxOpacity ?? 1.0).toFixed(2)}
            </Text>
          </Flex>
        )}
      </Box>

      {/* Glow */}
      <Box>
        <SectionLabel>Glow</SectionLabel>
        <Flex gap="6px" align="center" mb="8px">
          <ToggleBtn
            icon={<Box w="14px" h="14px" bg="#00FFFF" borderRadius="full" boxShadow="0 0 6px #00FFFF" />}
            label={captionPreset.glowColor ? "On" : "Off"}
            active={!!captionPreset.glowColor}
            onClick={() =>
              update(
                captionPreset.glowColor
                  ? { glowColor: undefined, glowIntensity: undefined }
                  : { glowColor: "#00FFFF", glowIntensity: 8 },
              )
            }
          />
          {captionPreset.glowColor && (
            <ColorField
              label="Color"
              value={captionPreset.glowColor}
              onChange={(v) => update({ glowColor: v })}
            />
          )}
        </Flex>
        {captionPreset.glowColor && (
          <Flex align="center" gap="10px">
            <Text fontSize="10px" color="#555" w="50px">Intensity</Text>
            <Slider.Root
              value={[captionPreset.glowIntensity ?? 8]}
              min={0}
              max={20}
              step={1}
              onValueChange={(e) => update({ glowIntensity: e.value[0]! })}
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
            <Text fontSize="10px" color="#888" fontFamily="mono" w="20px">
              {captionPreset.glowIntensity ?? 8}
            </Text>
          </Flex>
        )}
      </Box>
    </Stack>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

export function CaptionsPanel() {
  const [activeTab, setActiveTab] = useState<"presets" | "customize">("presets");
  const { captionPreset } = useStudio();

  return (
    <Stack gap="0">
      {/* Tabs */}
      <Flex px="12px" pt="12px" gap="4px" mb="12px">
        {(["presets", "customize"] as const).map((tab) => (
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

      {/* Caption preview */}
      <Box
        mx="12px"
        mb="12px"
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
            textTransform={(captionPreset.textTransform ?? "uppercase") as any}
            style={{
              fontFamily: `"${captionPreset.fontName}", Impact, sans-serif`,
              color: captionPreset.primaryColor,
              textShadow: captionPreset.shadow
                ? "0 2px 6px rgba(0,0,0,0.9), -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000"
                : "none",
              letterSpacing: `${captionPreset.letterSpacing ?? 0.04}em`,
            }}
          >
            PREVIEW{" "}
            <Box as="span" style={{ color: captionPreset.highlightColor ?? "#00ff88" }}>
              TEXT
            </Box>
          </Text>
        </Box>
      </Box>

      {activeTab === "presets" && <PresetsGrid />}
      {activeTab === "customize" && <CustomizeControls />}

      {/* Apply button */}
      <Box px="12px" pb="12px" pt="4px">
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
      </Box>
    </Stack>
  );
}
