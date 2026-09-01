"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Slider } from "@chakra-ui/react";
import { Zap, Layers } from "lucide-react";
import { toaster } from "@narriflow/ui";
import { useStudio } from "../studio-shell";

const TRANSITIONS = [
  { id: "none", label: "Cut" },
  { id: "fade", label: "Fade" },
  { id: "fade-black", label: "Fade to black" },
  { id: "dip-white", label: "Dip White" },
] as const;

export function TransitionsPanel() {
  const { studioEdits, setStudioEdits, clipInfo } = useStudio();
  const [selected, setSelected] = useState(studioEdits.transition.type);
  const [duration, setDuration] = useState(studioEdits.transition.durationSec);
  const [applyState, setApplyState] = useState<
    "idle" | "applying" | "applied" | "error"
  >("idle");

  // "Apply to all clips": commits the current selection to this clip's own
  // document first (same as the plain "Apply transition" action, so this
  // clip's preview updates immediately and the change autosaves normally),
  // then bulk-patches every OTHER clip in the project server-side.
  // excludeClipId keeps this clip out of the server-side write — it already
  // has the change locally and will persist it through the normal
  // revision-guarded autosave; including it here would bump its
  // editorRevision out from under that autosave's baseRevision and 409 it.
  async function handleApplyToAll() {
    if (applyState === "applying") return;
    setStudioEdits((prev) => ({
      ...prev,
      transition: { type: selected, durationSec: duration },
    }));
    setApplyState("applying");
    try {
      const res = await fetch(
        `/api/projects/${clipInfo.projectId}/clips/apply-studio-edits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            patches: [
              { transition: { type: selected, durationSec: duration } },
            ],
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
        description: "The transition wasn't applied to the other clips. Try again.",
      });
      setTimeout(() => setApplyState("idle"), 3000);
    }
  }

  return (
    <Stack gap="16px" p="12px">
      {/* Transition grid */}
      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="10px">
          Style
        </Text>
        <Box
          display="grid"
          style={{ gridTemplateColumns: "repeat(2, 1fr)", gap: "6px" }}
        >
          {TRANSITIONS.map((t) => {
            const isActive = selected === t.id;
            return (
              <Flex
                key={t.id}
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
                onClick={() => setSelected(t.id)}
                transition="background 120ms ease, border-color 120ms ease"
                _hover={{ borderColor: isActive ? "studio.accent" : "studio.borderStrong" }}
              >
                <Text fontSize="11px" color={isActive ? "studio.accentFg" : "studio.fgMuted"} fontWeight="500">
                  {t.label}
                </Text>
              </Flex>
            );
          })}
        </Box>
      </Box>

      {/* Duration */}
      <Box>
        <Flex align="center" justify="space-between" mb="8px">
          <Text textStyle="eyebrow" color="studio.fgMuted">
            Duration
          </Text>
          <Text textStyle="data" fontSize="11px" color="studio.timecode">{duration.toFixed(1)}s</Text>
        </Flex>
        <Slider.Root
          aria-label={["Transition duration"]}
          value={[duration]}
          min={0.1}
          max={1.5}
          step={0.05}
          onValueChange={(e) => setDuration(e.value[0]!)}
          size="sm"
          colorPalette="accent"
          w="100%"
        >
          <Slider.Control>
            <Slider.Track>
              <Slider.Range />
            </Slider.Track>
            <Slider.Thumbs />
          </Slider.Control>
        </Slider.Root>
        <Flex justify="space-between" mt="4px">
          <Text textStyle="data" fontSize="10.5px" color="studio.fgSubtle">0.1s</Text>
          <Text textStyle="data" fontSize="10.5px" color="studio.fgSubtle">1.5s</Text>
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
        onClick={() =>
          setStudioEdits((prev) => ({
            ...prev,
            transition: { type: selected, durationSec: duration },
          }))
        }
      >
        <Zap size={13} />
        Apply transition
      </Flex>

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
