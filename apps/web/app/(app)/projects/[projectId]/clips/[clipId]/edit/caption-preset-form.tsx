"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@narriflow/ui/components/button";
import type { CaptionPreset } from "@narriflow/validators";
import { Box, Flex, Stack, Text, HStack } from "@chakra-ui/react";
import { Check, Loader, RotateCcw } from "lucide-react";

const FONT_OPTIONS = [
  "Arial",
  "Impact",
  "Roboto",
  "Open Sans",
  "Montserrat",
  "Oswald",
  "Bebas Neue",
];

const DEFAULT_PRESET: CaptionPreset = {
  fontName: "Arial",
  primaryColor: "#FFFFFF",
  outlineColor: "#000000",
  outlineWidth: 2,
  shadow: 1,
  bold: true,
  position: "bottom",
  highlightColor: "#00FF88",
  animation: "word-by-word",
  fontSize: 36,
};

function ColorSwatch({ color }: { color: string }) {
  return (
    <Box
      w="20px"
      h="20px"
      borderRadius="4px"
      borderWidth="1px"
      borderColor="border"
      bg={color}
      flexShrink={0}
    />
  );
}

export function CaptionPresetForm({
  projectId,
  clipId,
  initialPreset,
}: {
  projectId: string;
  clipId: string;
  initialPreset: CaptionPreset | null | undefined;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [fontName, setFontName] = useState(
    initialPreset?.fontName ?? DEFAULT_PRESET.fontName,
  );
  const [primaryColor, setPrimaryColor] = useState(
    initialPreset?.primaryColor ?? DEFAULT_PRESET.primaryColor,
  );
  const [outlineColor, setOutlineColor] = useState(
    initialPreset?.outlineColor ?? DEFAULT_PRESET.outlineColor,
  );
  const [outlineWidth, setOutlineWidth] = useState(
    initialPreset?.outlineWidth ?? DEFAULT_PRESET.outlineWidth,
  );
  const [shadow, setShadow] = useState(
    initialPreset?.shadow ?? DEFAULT_PRESET.shadow,
  );
  const [bold, setBold] = useState(
    initialPreset?.bold ?? DEFAULT_PRESET.bold,
  );
  const [position, setPosition] = useState<"bottom" | "top" | "center">(
    initialPreset?.position ?? DEFAULT_PRESET.position,
  );
  const [highlightColor, setHighlightColor] = useState(
    initialPreset?.highlightColor ?? DEFAULT_PRESET.highlightColor,
  );
  const [animation, setAnimation] = useState(
    initialPreset?.animation ?? DEFAULT_PRESET.animation,
  );

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);

    const preset: CaptionPreset = {
      fontName,
      primaryColor,
      outlineColor,
      outlineWidth,
      shadow,
      bold,
      position,
      highlightColor,
      animation,
      fontSize: initialPreset?.fontSize ?? DEFAULT_PRESET.fontSize,
    };

    try {
      const response = await fetch(
        `/api/projects/${projectId}/clips/${clipId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ captionPreset: preset }),
        },
      );

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setSaveError(data.error ?? "Failed to save");
        return;
      }

      setSaved(true);
      startTransition(() => {
        router.refresh();
      });
    } catch {
      setSaveError("Network error");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setFontName(DEFAULT_PRESET.fontName);
    setPrimaryColor(DEFAULT_PRESET.primaryColor);
    setOutlineColor(DEFAULT_PRESET.outlineColor);
    setOutlineWidth(DEFAULT_PRESET.outlineWidth);
    setShadow(DEFAULT_PRESET.shadow);
    setBold(DEFAULT_PRESET.bold);
    setPosition(DEFAULT_PRESET.position);
    setHighlightColor(DEFAULT_PRESET.highlightColor);
    setAnimation(DEFAULT_PRESET.animation);
    setSaved(false);
  }

  const inputStyle = {
    padding: "6px 10px",
    fontSize: "13px",
    borderRadius: "6px",
    border: "1px solid var(--chakra-colors-border)",
    background: "transparent",
    color: "inherit",
    width: "100%",
  } as const;

  return (
    <Stack gap="20px">
      {/* Font */}
      <Box>
        <Text fontSize="12px" fontWeight="500" color="fg.muted" mb="6px">
          Font
        </Text>
        <select
          value={fontName}
          onChange={(e) => setFontName(e.target.value)}
          style={{ ...inputStyle, maxWidth: "240px" }}
        >
          {FONT_OPTIONS.map((font) => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
        </select>
      </Box>

      {/* Text color */}
      <Box>
        <Text fontSize="12px" fontWeight="500" color="fg.muted" mb="6px">
          Text color
        </Text>
        <HStack gap="8px">
          <ColorSwatch color={primaryColor} />
          <input
            type="color"
            value={primaryColor}
            onChange={(e) => setPrimaryColor(e.target.value)}
            style={{ width: "40px", height: "28px", cursor: "pointer", borderRadius: "4px" }}
          />
          <input
            type="text"
            value={primaryColor}
            onChange={(e) => {
              const v = e.target.value;
              if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) setPrimaryColor(v);
            }}
            style={{ ...inputStyle, maxWidth: "100px", fontFamily: "monospace" }}
          />
        </HStack>
      </Box>

      {/* Outline color */}
      <Box>
        <Text fontSize="12px" fontWeight="500" color="fg.muted" mb="6px">
          Outline color
        </Text>
        <HStack gap="8px">
          <ColorSwatch color={outlineColor} />
          <input
            type="color"
            value={outlineColor}
            onChange={(e) => setOutlineColor(e.target.value)}
            style={{ width: "40px", height: "28px", cursor: "pointer", borderRadius: "4px" }}
          />
          <input
            type="text"
            value={outlineColor}
            onChange={(e) => {
              const v = e.target.value;
              if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) setOutlineColor(v);
            }}
            style={{ ...inputStyle, maxWidth: "100px", fontFamily: "monospace" }}
          />
        </HStack>
      </Box>

      {/* Outline width */}
      <Box>
        <Text fontSize="12px" fontWeight="500" color="fg.muted" mb="6px">
          Outline width (0–4)
        </Text>
        <input
          type="number"
          min={0}
          max={4}
          step={1}
          value={outlineWidth}
          onChange={(e) => setOutlineWidth(Number(e.target.value))}
          style={{ ...inputStyle, maxWidth: "80px" }}
        />
      </Box>

      {/* Bold + Shadow + Position */}
      <Flex gap="24px" flexWrap="wrap">
        <Box>
          <Text fontSize="12px" fontWeight="500" color="fg.muted" mb="6px">
            Bold
          </Text>
          <Flex as="label" align="center" gap="8px" cursor="pointer">
            <input
              type="checkbox"
              checked={bold}
              onChange={(e) => setBold(e.target.checked)}
            />
            <Text fontSize="13px" color="fg">
              Bold text
            </Text>
          </Flex>
        </Box>

        <Box>
          <Text fontSize="12px" fontWeight="500" color="fg.muted" mb="6px">
            Drop shadow
          </Text>
          <Flex as="label" align="center" gap="8px" cursor="pointer">
            <input
              type="checkbox"
              checked={shadow === 1}
              onChange={(e) => setShadow(e.target.checked ? 1 : 0)}
            />
            <Text fontSize="13px" color="fg">
              Enable shadow
            </Text>
          </Flex>
        </Box>

        <Box>
          <Text fontSize="12px" fontWeight="500" color="fg.muted" mb="6px">
            Position
          </Text>
          <select
            value={position}
            onChange={(e) => setPosition(e.target.value as "bottom" | "top" | "center")}
            style={{ ...inputStyle, maxWidth: "160px" }}
          >
            <option value="bottom">Bottom</option>
            <option value="center">Center</option>
            <option value="top">Top</option>
          </select>
        </Box>
      </Flex>

      {/* Highlight color */}
      <Box>
        <Text fontSize="12px" fontWeight="500" color="fg.muted" mb="6px">
          Highlight color
        </Text>
        <HStack gap="8px">
          <ColorSwatch color={highlightColor} />
          <input
            type="color"
            value={highlightColor}
            onChange={(e) => setHighlightColor(e.target.value)}
            style={{ width: "40px", height: "28px", cursor: "pointer", borderRadius: "4px" }}
          />
          <input
            type="text"
            value={highlightColor}
            onChange={(e) => {
              const v = e.target.value;
              if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) setHighlightColor(v);
            }}
            style={{ ...inputStyle, maxWidth: "100px", fontFamily: "monospace" }}
          />
        </HStack>
      </Box>

      {/* Animation */}
      <Box>
        <Text fontSize="12px" fontWeight="500" color="fg.muted" mb="6px">
          Caption animation
        </Text>
        <select
          value={animation}
          onChange={(e) => setAnimation(e.target.value as CaptionPreset["animation"])}
          style={{ ...inputStyle, maxWidth: "200px" }}
        >
          <option value="none">None</option>
          <option value="word-by-word">Word by word</option>
          <option value="karaoke">Karaoke</option>
          <option value="bounce">Bounce</option>
        </select>
      </Box>

      {/* Preview hint */}
      <Box
        px="12px"
        py="10px"
        borderRadius="8px"
        bg="bg.muted"
        borderWidth="1px"
        borderColor="border"
      >
        <Text fontSize="12px" color="fg.muted">
          Changes apply to new renders. Re-render the clip after saving to see the updated captions.
        </Text>
      </Box>

      {saveError && (
        <Text fontSize="12px" color="danger.fg">
          {saveError}
        </Text>
      )}

      <Flex gap="8px">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || isPending}
        >
          {saving ? (
            <Loader size={14} className="animate-spin" />
          ) : saved ? (
            <Check size={14} />
          ) : null}
          <Text ml={saving || saved ? "4px" : "0"}>
            {saving ? "Saving..." : saved ? "Saved" : "Save preset"}
          </Text>
        </Button>
        <Button size="sm" variant="outline" onClick={handleReset} disabled={saving}>
          <RotateCcw size={14} />
          <Text ml="4px">Reset to defaults</Text>
        </Button>
      </Flex>
    </Stack>
  );
}
