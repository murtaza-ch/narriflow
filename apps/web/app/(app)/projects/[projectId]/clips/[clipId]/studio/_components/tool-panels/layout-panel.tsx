"use client";

import { useEffect, useState } from "react";
import { Box, Flex, Text, Stack, Input } from "@chakra-ui/react";
import { Palette, ImageIcon, Link2, AlertTriangle, Layers, ScanFace, Crop, Frame } from "lucide-react";
import { toaster } from "@narriflow/ui";
import { useStudio } from "../studio-shell";
import {
  resolveEffectiveFramingMode,
  type ApplyStudioEditsPatch,
  type EffectiveFramingMode,
} from "@narriflow/validators";

// Vizard-parity Phase C-2 stage 1: per-clip framing mode. Three effective
// modes, resolved by the shared `resolveEffectiveFramingMode` helper so this
// panel, the worker's render pipeline, and the preview can never fork on the
// answer:
//  - "auto"   — crop to fill, following the speaker's face when detected
//               (`studioEdits.framing.mode === "auto"`, the default).
//  - "center" — crop to fill, always centered, no face detection
//               (`studioEdits.framing.mode === "center"`).
//  - "fit"    — letterbox instead of crop; a color or image fills the empty
//               frame (`studioEdits.background.mode !== "off"` — this is
//               NOT a `framing` value, it's derived entirely from
//               `background` so the two fields can't disagree; see
//               `studioFramingSchema`'s doc comment in
//               packages/validators/src/studio-edits.ts).
// See buildFitAndBackgroundFilter / shouldRunAutoReframeDetection
// (apps/worker/src/tasks/render-clips.ts) for the burn-in side of this
// parity contract, and video-preview.tsx for how the stage renders it live.

const FRAMING_MODES: {
  id: EffectiveFramingMode;
  label: string;
  icon: React.ReactNode;
}[] = [
  { id: "auto",   label: "Auto reframe",       icon: <ScanFace size={15} /> },
  { id: "center", label: "Center crop",        icon: <Crop size={15} /> },
  { id: "fit",    label: "Fit + background",   icon: <Frame size={15} /> },
];

// "None" isn't offered here — inside Fit the only choices are Color/Image
// (Fit itself already replaces "off"/crop-to-fill at the top level above).
const BACKGROUND_SUBMODES: { id: "color" | "image"; label: string; icon: React.ReactNode }[] = [
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

export function LayoutPanel() {
  const { studioEdits, setStudioEdits, endCoalesce, clipInfo } = useStudio();
  const background = studioEdits.background;
  const effectiveMode = resolveEffectiveFramingMode(studioEdits);

  const [colorDraft, setColorDraft] = useState(background.color ?? "#000000");
  const [imageUrlDraft, setImageUrlDraft] = useState(background.imageUrl ?? "");
  const [imageUrlError, setImageUrlError] = useState(false);
  const [applyState, setApplyState] = useState<
    "idle" | "applying" | "applied" | "error"
  >("idle");

  // "Apply to all clips": everything above is already committed locally
  // (live, not staged), so this bulk-patches every OTHER clip in the
  // project to match. `applyStudioEditsPatchSchema` is a strict XOR — one
  // call can only carry ONE of transition/background/framing — so which
  // field(s) we send depends on the effective mode:
  //  - Fit: `background` alone is enough. It always wins over `framing` on
  //    the receiving clip (see resolveEffectiveFramingMode), so there's
  //    nothing else to send.
  //  - Auto/Center: send `framing` for the mode itself, PLUS a second
  //    `background: { mode: "off" }` call — without it, a receiving clip
  //    that currently has its own background active would keep showing
  //    "fit" (background always wins), silently ignoring the framing patch
  //    that was just applied. Two sequential calls, not a combined payload,
  //    because the patch schema only ever carries one field.
  async function handleApplyToAll() {
    if (applyState === "applying") return;
    setApplyState("applying");
    try {
      const patches: ApplyStudioEditsPatch[] =
        effectiveMode === "fit"
          ? [{ background }]
          : [
              { framing: studioEdits.framing },
              { background: { ...background, mode: "off" } },
            ];

      let updated = 0;
      for (const patch of patches) {
        const res = await fetch(
          `/api/projects/${clipInfo.projectId}/clips/apply-studio-edits`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ patch, excludeClipId: clipInfo.id }),
          },
        );
        if (!res.ok) throw new Error("apply failed");
        const data = (await res.json()) as { updated: number };
        // The primary patch (framing, or background for fit) drives the
        // count shown to the user; the secondary background-off call's
        // count would double-count rows already touched by the first.
        if (patch === patches[0]) updated = data.updated;
      }

      setApplyState("applied");
      toaster.create({
        type: "success",
        title:
          updated > 0
            ? `Applied to ${updated} other clip${updated === 1 ? "" : "s"}`
            : "Every other clip already matches",
      });
      setTimeout(() => setApplyState("idle"), 2000);
    } catch {
      setApplyState("error");
      toaster.create({
        type: "error",
        title: "Couldn't apply to all clips",
        description: "The layout wasn't applied to the other clips. Try again.",
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

  // Top-level radio: one coherent group, no contradictory states. Auto/
  // Center always force `background.mode` back to "off" (framing only takes
  // effect when background is off — see resolveEffectiveFramingMode); Fit
  // switches `background.mode` to "color" (defaulting color to black if
  // none was ever set) unless it's already active, in which case its
  // existing color/image choice is left untouched.
  const setFramingChoice = (choice: EffectiveFramingMode) => {
    setStudioEdits((prev) => {
      if (choice === "fit") {
        const alreadyFit = prev.background.mode !== "off";
        return {
          ...prev,
          background: alreadyFit
            ? prev.background
            : { ...prev.background, mode: "color", color: prev.background.color ?? "#000000" },
        };
      }
      return {
        ...prev,
        framing: { mode: choice },
        background: { ...prev.background, mode: "off" },
      };
    });
  };

  const setBackgroundSubmode = (mode: "color" | "image") => {
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
          Framing
        </Text>
        <Box display="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: "6px" }}>
          {FRAMING_MODES.map((m) => {
            const isActive = effectiveMode === m.id;
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
                onClick={() => setFramingChoice(m.id)}
                transition="background 120ms ease, border-color 120ms ease"
                _hover={{ borderColor: isActive ? "studio.accent" : "studio.borderStrong" }}
                color={isActive ? "studio.accentFg" : "studio.fgMuted"}
              >
                {m.icon}
                <Text fontSize="11px" fontWeight="500" textAlign="center">
                  {m.label}
                </Text>
              </Flex>
            );
          })}
        </Box>
      </Box>

      {effectiveMode === "auto" && (
        <Text fontSize="11px" color="studio.fgSubtle" lineHeight="1.6">
          The source video crops to fill the canvas, automatically following
          the speaker&apos;s face when one is detected.
        </Text>
      )}

      {effectiveMode === "center" && (
        <Text fontSize="11px" color="studio.fgSubtle" lineHeight="1.6">
          The source video crops to fill the canvas, always centered — no
          face detection runs for this clip.
        </Text>
      )}

      {effectiveMode === "fit" && (
        <>
          <Box>
            <Text textStyle="eyebrow" color="studio.fgMuted" mb="10px">
              Background
            </Text>
            <Box display="grid" style={{ gridTemplateColumns: "repeat(2, 1fr)", gap: "6px" }}>
              {BACKGROUND_SUBMODES.map((m) => {
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
                    onClick={() => setBackgroundSubmode(m.id)}
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
        </>
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
