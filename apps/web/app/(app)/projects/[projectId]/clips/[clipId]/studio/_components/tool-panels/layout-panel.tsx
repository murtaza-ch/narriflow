"use client";

import { useEffect, useState } from "react";
import { Box, Flex, Text, Stack, Input, Checkbox } from "@chakra-ui/react";
import { Palette, ImageIcon, Link2, AlertTriangle } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import { useStudio } from "../studio-shell";
import {
  resolveEffectiveFramingMode,
  type ApplyStudioEditsPatch,
  type EffectiveFramingMode,
} from "@narriflow/validators";
import { FramingPresetGrid } from "./framing-preset-thumbnails";

// Five effective modes share one resolver. Automatic, Center, and Fit feed
// the same composition planner as explicit Split and Screen. Identity-bound
// worker evidence supplies analysis; the planner owns all per-target geometry
// and fallback decisions; Studio and FFmpeg adapt the resulting plan.

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
  const { studioEdits, setStudioEdits, endCoalesce, clipInfo } = useStudio("studioEdits", "setStudioEdits", "endCoalesce", "clipInfo");
  const background = studioEdits.background;
  const effectiveMode = resolveEffectiveFramingMode(studioEdits);

  const [colorDraft, setColorDraft] = useState(background.color ?? "#000000");
  const [imageUrlDraft, setImageUrlDraft] = useState(background.imageUrl ?? "");
  const [imageUrlError, setImageUrlError] = useState(false);
  const [applyState, setApplyState] = useState<
    "idle" | "applying" | "applied" | "error"
  >("idle");

  // "Apply to all" — Vizard-style checkbox in the header row, session-local
  // only (never persisted, always starts unchecked). Checking it does NOT
  // itself apply anything; while checked, each subsequent discrete edit
  // below (preset tile, background submode, a color commit, an image-URL
  // apply) ALSO bulk-patches every OTHER clip in the project, in addition
  // to its instant local effect on the open clip.
  const [applyToAll, setApplyToAll] = useState(false);

  // Bulk-apply worker shared by every control below. Each patch changes one
  // Studio field, while the request can group related fields into one atomic
  // project mutation:
  //  - Fit-only changes (submode switch, color commit, image apply): a
  //    single `background` patch is enough. It always wins over `framing`
  //    on the receiving clip (see resolveEffectiveFramingMode), so there's
  //    nothing else to send.
  //  - Switching to Auto/Center: send `framing` for the mode itself, plus
  //    `background: { mode: "off" }` in the same request. Without it, a receiving
  //    clip that currently has its own background active would keep
  //    showing "fit" (background always wins), silently ignoring the
  //    framing patch that was just applied.
  // A failure here never rolls back the already-committed local change on
  // the open clip — the open clip keeps its new value either way.
  async function applyPatchesToAll(patches: ApplyStudioEditsPatch[]) {
    if (applyState === "applying") return;
    setApplyState("applying");
    try {
      const res = await fetch(
        `/api/projects/${clipInfo.projectId}/clips/apply-studio-edits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patches, excludeClipId: clipInfo.id }),
        },
      );
      if (!res.ok) throw new Error("apply failed");
      const { updated } = (await res.json()) as { updated: number };

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

  // Preset tile select: one coherent group, no contradictory states. Auto/
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

    if (!applyToAll) return;
    const patches: ApplyStudioEditsPatch[] =
      choice === "fit"
        ? [
            {
              background:
                background.mode !== "off"
                  ? background
                  : { ...background, mode: "color", color: background.color ?? "#000000" },
            },
          ]
        : [
            { framing: { mode: choice } },
            { background: { ...background, mode: "off" } },
          ];
    void applyPatchesToAll(patches);
  };

  const setBackgroundSubmode = (mode: "color" | "image") => {
    setStudioEdits((prev) => ({
      ...prev,
      background: { ...prev.background, mode },
    }));
    if (applyToAll) {
      void applyPatchesToAll([{ background: { ...background, mode } }]);
    }
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

  // Fires the bulk apply for a color COMMIT only (swatch click, or the hex
  // input settling on blur) — never per keystroke/coalesced tick.
  const commitColorToAll = (hex: string) => {
    if (!applyToAll) return;
    void applyPatchesToAll([{ background: { ...background, mode: "color", color: hex } }]);
  };

  const applyImageUrl = () => {
    const trimmed = imageUrlDraft.trim();
    if (!trimmed) {
      setImageUrlError(false);
      setStudioEdits((prev) => ({
        ...prev,
        background: { ...prev.background, mode: "image", imageUrl: null },
      }));
      if (applyToAll) {
        void applyPatchesToAll([{ background: { ...background, mode: "image", imageUrl: null } }]);
      }
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
    if (applyToAll) {
      void applyPatchesToAll([{ background: { ...background, mode: "image", imageUrl: trimmed } }]);
    }
  };

  return (
    <Stack gap="16px" p="12px">
      <Box>
        <Flex align="center" justify="space-between" mb="10px">
          <Text textStyle="eyebrow" color="studio.fgMuted">
            Layout
          </Text>
          <Flex align="center" gap="8px">
            {applyState !== "idle" && (
              <Text
                fontSize="10.5px"
                color={applyState === "error" ? "studio.danger" : "studio.fgSubtle"}
              >
                {applyState === "applying"
                  ? "Applying…"
                  : applyState === "applied"
                    ? "Applied ✓"
                    : "Failed — try again"}
              </Text>
            )}
            <Checkbox.Root
              checked={applyToAll}
              onCheckedChange={(e) => setApplyToAll(!!e.checked)}
              size="sm"
              colorPalette="accent"
              gap="6px"
              cursor="pointer"
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label>
                <Text fontSize="11px" color="studio.fgMuted">
                  Apply to all
                </Text>
              </Checkbox.Label>
            </Checkbox.Root>
          </Flex>
        </Flex>
        <FramingPresetGrid selected={effectiveMode} onSelect={setFramingChoice} />
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

      {effectiveMode === "split" && (
        <Text fontSize="11px" color="studio.fgSubtle" lineHeight="1.6">
          Stacks two detected speakers into vertically split tiles. Falls
          back to auto-reframe (following the speaker&apos;s face, or a
          centered crop if none is detected) when the footage doesn&apos;t
          support a 2-up split — e.g. only one speaker is ever on screen at
          once.
        </Text>
      )}

      {effectiveMode === "screen" && (
        <Text fontSize="11px" color="studio.fgSubtle" lineHeight="1.6">
          Fits the full screen-share into the top tile and seats a
          face-tracked crop of the speaker below. Keeps the layout with a
          centered, untracked crop below when no face is detected — falls
          back to auto-reframe (following the speaker&apos;s face, or a
          centered crop if none is detected) for b-roll cutaways instead.
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
                        onClick={() => {
                          setColor(hex);
                          commitColorToAll(hex);
                        }}
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
                    onBlur={() => {
                      endCoalesce();
                      if (HEX_PATTERN.test(colorDraft)) {
                        commitColorToAll(colorDraft);
                      }
                    }}
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
    </Stack>
  );
}
