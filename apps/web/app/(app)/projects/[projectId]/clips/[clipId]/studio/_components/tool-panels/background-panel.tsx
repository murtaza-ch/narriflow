"use client";

import { useEffect, useState } from "react";
import { Box, Flex, Text, Stack, Input } from "@chakra-ui/react";
import { Ban, Palette, ImageIcon, Link2, AlertTriangle, Layers } from "lucide-react";
import { toaster } from "@narriflow/ui";
import { useStudio } from "../studio-shell";
import type { StudioBackground } from "@narriflow/validators";

// Vizard-parity Phase C item 2: per-clip canvas background. "off" preserves
// the crop-to-fill behavior the studio has always had; "color"/"image" switch
// the render (and this preview) to "fit" — the source letterboxes instead of
// cropping, and the empty frame shows a solid color or an image behind it.
// See buildFitAndBackgroundFilter (apps/worker/src/tasks/render-clips.ts) for
// the burn-in side of this parity contract, and video-preview.tsx for how the
// stage renders it live.

const MODES: { id: StudioBackground["mode"]; label: string; icon: React.ReactNode }[] = [
  { id: "off",   label: "None",  icon: <Ban size={15} /> },
  { id: "color", label: "Color", icon: <Palette size={15} /> },
  { id: "image", label: "Image", icon: <ImageIcon size={15} /> },
];

// Sensible defaults spanning neutrals + a few saturated picks — not the
// user's brand palette (studio chrome stays on studio.* tokens; these are
// USER content color choices, the documented hardcoded-hex exception).
const SWATCHES = [
  "#000000", "#FFFFFF", "#111827", "#6B7280",
  "#DC2626", "#EA580C", "#CA8A04", "#16A34A",
  "#2563EB", "#7C3AED",
];

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function BackgroundPanel() {
  const { studioEdits, setStudioEdits, endCoalesce, clipInfo } = useStudio();
  const background = studioEdits.background;

  const [colorDraft, setColorDraft] = useState(background.color ?? "#000000");
  const [imageUrlDraft, setImageUrlDraft] = useState(background.imageUrl ?? "");
  const [imageUrlError, setImageUrlError] = useState(false);
  const [applyState, setApplyState] = useState<
    "idle" | "applying" | "applied" | "error"
  >("idle");

  // "Apply to all clips": the background is already committed locally on
  // every interaction above (mode/color/image are live, not staged), so
  // this just bulk-patches every OTHER clip in the project with the current
  // value. excludeClipId keeps this clip out of the server-side write for
  // the same reason transitions-panel.tsx does — it already has the change
  // locally and would otherwise 409 its own next autosave.
  async function handleApplyToAll() {
    if (applyState === "applying") return;
    setApplyState("applying");
    try {
      const res = await fetch(
        `/api/projects/${clipInfo.projectId}/clips/apply-studio-edits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            patch: { background },
            excludeClipId: clipInfo.id,
          }),
        },
      );
      if (!res.ok) throw new Error("apply failed");
      const data = (await res.json()) as { updated: number };
      setApplyState("applied");
      toaster.create({
        type: "success",
        title:
          data.updated > 0
            ? `Applied to ${data.updated} other clip${data.updated === 1 ? "" : "s"}`
            : "Every other clip already matches",
      });
      setTimeout(() => setApplyState("idle"), 2000);
    } catch {
      setApplyState("error");
      toaster.create({
        type: "error",
        title: "Couldn't apply to all clips",
        description: "The background wasn't applied to the other clips. Try again.",
      });
      setTimeout(() => setApplyState("idle"), 3000);
    }
  }

  // Resync local drafts whenever the document's own background object
  // actually changes identity (undo/redo/reset all produce a NEW object;
  // unrelated studioEdits changes preserve the same reference) — same fix
  // pattern music-panel.tsx uses so an in-progress edit here can't go stale
  // after an undo.
  useEffect(() => {
    setColorDraft(background.color ?? "#000000");
    setImageUrlDraft(background.imageUrl ?? "");
    setImageUrlError(false);
  }, [background]);

  const setMode = (mode: StudioBackground["mode"]) => {
    setStudioEdits((prev) => ({
      ...prev,
      background: { ...prev.background, mode },
    }));
  };

  const setColor = (hex: string, coalesceKey?: string) => {
    setStudioEdits(
      (prev) => ({
        ...prev,
        background: { ...prev.background, mode: "color", color: hex },
      }),
      coalesceKey,
    );
  };

  const applyImageUrl = () => {
    const trimmed = imageUrlDraft.trim();
    if (!trimmed) {
      setImageUrlError(false);
      setStudioEdits((prev) => ({
        ...prev,
        background: { ...prev.background, mode: "image", imageUrl: null },
      }));
      return;
    }
    if (!isValidHttpUrl(trimmed)) {
      setImageUrlError(true);
      return;
    }
    setImageUrlError(false);
    setStudioEdits((prev) => ({
      ...prev,
      background: { ...prev.background, mode: "image", imageUrl: trimmed },
    }));
  };

  return (
    <Stack gap="16px" p="12px">
      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="10px">
          Mode
        </Text>
        <Box display="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: "6px" }}>
          {MODES.map((m) => {
            const isActive = background.mode === m.id;
            return (
              <Flex
                key={m.id}
                as="button"
                aria-pressed={isActive}
                direction="column"
                align="center"
                justify="center"
                gap="6px"
                py="14px"
                borderRadius="l2"
                bg={isActive ? "studio.raised" : "studio.subtle"}
                border="1px solid"
                borderColor={isActive ? "studio.accent" : "studio.border"}
                cursor="pointer"
                onClick={() => setMode(m.id)}
                transition="background 120ms ease, border-color 120ms ease"
                _hover={{ borderColor: isActive ? "studio.accent" : "studio.borderStrong" }}
                color={isActive ? "studio.accentFg" : "studio.fgMuted"}
              >
                {m.icon}
                <Text fontSize="11px" fontWeight="500">
                  {m.label}
                </Text>
              </Flex>
            );
          })}
        </Box>
      </Box>

      {background.mode === "color" && (
        <>
          <Box>
            <Text textStyle="eyebrow" color="studio.fgMuted" mb="10px">
              Swatches
            </Text>
            <Box display="grid" style={{ gridTemplateColumns: "repeat(5, 1fr)", gap: "8px" }}>
              {SWATCHES.map((hex) => {
                const isActive = (background.color ?? "#000000").toUpperCase() === hex.toUpperCase();
                return (
                  <Box
                    key={hex}
                    as="button"
                    aria-label={`Use ${hex}`}
                    aria-pressed={isActive}
                    onClick={() => setColor(hex)}
                    w="100%"
                    aspectRatio={1}
                    borderRadius="l2"
                    bg={hex}
                    borderWidth={isActive ? "2px" : "1px"}
                    borderColor={isActive ? "studio.accent" : "studio.borderStrong"}
                    cursor="pointer"
                    transition="border-color 120ms ease, transform 120ms ease"
                    _hover={{ transform: "scale(1.06)" }}
                  />
                );
              })}
            </Box>
          </Box>

          <Box>
            <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
              Hex
            </Text>
            <Flex align="center" gap="8px">
              <Box
                flexShrink={0}
                w="32px"
                h="32px"
                borderRadius="l2"
                borderWidth="1px"
                borderColor="studio.borderStrong"
                bg={HEX_PATTERN.test(colorDraft) ? colorDraft : "studio.subtle"}
              />
              <Input
                aria-label="Background color hex"
                value={colorDraft}
                onChange={(event) => {
                  const next = event.target.value;
                  setColorDraft(next);
                  if (HEX_PATTERN.test(next)) {
                    setColor(next, "bg-color-hex");
                  }
                }}
                onBlur={endCoalesce}
                placeholder="#000000"
                size="sm"
                bg="studio.subtle"
                borderColor="studio.borderControl"
                color="studio.fg"
                fontSize="12px"
                textStyle="data"
                _placeholder={{ color: "studio.fgSubtle" }}
                _focusVisible={{ borderColor: "studio.ring", boxShadow: "none" }}
              />
            </Flex>
            {!HEX_PATTERN.test(colorDraft) && (
              <Text fontSize="10.5px" color="studio.fgSubtle" mt="4px">
                Format: #RRGGBB
              </Text>
            )}
          </Box>
        </>
      )}

      {background.mode === "image" && (
        <>
          <Box>
            <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
              Image URL
            </Text>
            <Flex
              align="center"
              gap="8px"
              px="10px"
              h="34px"
              borderRadius="l2"
              bg="studio.subtle"
              borderWidth="1px"
              borderColor={imageUrlError ? "studio.dangerBorder" : "studio.borderControl"}
              _focusWithin={{ borderColor: imageUrlError ? "studio.dangerBorder" : "studio.ring" }}
              transition="border-color 120ms ease"
            >
              <Box color="studio.fgSubtle" flexShrink={0}>
                <Link2 size={13} />
              </Box>
              <Input
                aria-label="Background image URL"
                placeholder="https://example.com/background.jpg"
                value={imageUrlDraft}
                onChange={(event) => {
                  setImageUrlDraft(event.target.value);
                  if (imageUrlError) setImageUrlError(false);
                }}
                size="xs"
                flex="1"
                fontSize="12px"
                color="studio.fg"
                css={{ border: "none", outline: "none", background: "transparent", boxShadow: "none" }}
                _placeholder={{ color: "studio.fgSubtle" }}
              />
            </Flex>
            {imageUrlError && (
              <Flex align="center" gap="5px" mt="6px" color="studio.danger">
                <AlertTriangle size={12} />
                <Text fontSize="10.5px">Enter a valid http(s) image URL</Text>
              </Flex>
            )}
          </Box>

          <Text fontSize="10.5px" color="studio.fgSubtle" lineHeight="1.5">
            The video letterboxes to fit inside the frame; this image fills the
            empty space behind it, cropped to cover the full canvas.
          </Text>

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
            onClick={applyImageUrl}
          >
            <ImageIcon size={13} />
            Apply image
          </Flex>

          {background.imageUrl && (
            <Text fontSize="10.5px" color="studio.fgSubtle" overflow="hidden" whiteSpace="nowrap" textOverflow="ellipsis">
              Applied: {background.imageUrl}
            </Text>
          )}
        </>
      )}

      {background.mode === "off" && (
        <Text fontSize="11px" color="studio.fgSubtle" lineHeight="1.6">
          The source video crops to fill the canvas, same as every clip today.
          Switch to Color or Image to letterbox it instead and fill the empty
          frame with a background.
        </Text>
      )}

      {/* Apply to all — secondary action (Export owns the solid button) */}
      <Flex
        as="button"
        align="center"
        justify="center"
        h="34px"
        borderRadius="l2"
        bg="studio.raised"
        borderWidth="1px"
        borderColor={applyState === "error" ? "danger.solid" : "studio.borderStrong"}
        color={applyState === "error" ? "danger.fg" : "studio.fg"}
        fontSize="12px"
        fontWeight="600"
        cursor={applyState === "applying" ? "default" : "pointer"}
        opacity={applyState === "applying" ? 0.8 : 1}
        gap="6px"
        transition="background 120ms ease, border-color 120ms ease"
        _hover={applyState === "applying" ? {} : { borderColor: applyState === "error" ? "danger.solid" : "studio.fgSubtle" }}
        onClick={handleApplyToAll}
      >
        <Layers size={13} />
        {applyState === "applying"
          ? "Applying…"
          : applyState === "applied"
            ? "Applied to all clips ✓"
            : applyState === "error"
              ? "Failed — try again"
              : "Apply to all clips"}
      </Flex>
    </Stack>
  );
}
