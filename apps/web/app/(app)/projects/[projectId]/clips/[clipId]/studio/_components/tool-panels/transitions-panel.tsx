"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Box, Flex, NativeSelect, Slider, Stack, Text } from "@chakra-ui/react";
import { PanelButton, PanelTabs, tileProps, studioSliderCss } from "./panel-ui";
import { Layers, Move, Sparkles, Zap } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import { PLAN_CATALOG, type MediaMotion, type SceneMotion } from "@narriflow/validators";
import {
  MOTION_ENTRANCE_OPTIONS,
  MOTION_EXIT_OPTIONS,
  TRANSITION_OPTIONS,
} from "@/lib/motion-options";
import { upgradePromptFromFailure, type BrowserRequestFailure } from "@/lib/authenticated-request-browser";
import { useUpgrade } from "@/app/(app)/_components/upgrade";
import { useStudio } from "../studio-shell";
import { StudioLockGem } from "../studio-lock-gem";

type MotionTab = "transition" | "media";

const TRANSITIONS = TRANSITION_OPTIONS.map((option) => ({
  id: option.value,
  label: option.shortLabel,
  family: option.family,
}));
const ENTRANCES = MOTION_ENTRANCE_OPTIONS.map((option) => ({ id: option.value, label: option.label }));
const EXITS = MOTION_EXIT_OPTIONS.map((option) => ({ id: option.value, label: option.label }));

function PresetPreview({ family }: { family: (typeof TRANSITIONS)[number]["family"] }) {
  return (
    <Box position="relative" w="full" h="40px" overflow="hidden" bg="studio.canvas" borderRadius="6px">
      <Box
        position="absolute"
        inset="5px"
        borderWidth="1px"
        borderColor="studio.borderStrong"
        bg={family === "fade" ? "studio.subtle" : "studio.surface"}
        opacity={family === "cut" ? 0.72 : 1}
        transform={family === "slide" ? "translateX(-16%)" : family === "zoom" ? "scale(.82)" : undefined}
        clipPath={family === "wipe" ? "inset(0 42% 0 0)" : undefined}
        transition="transform 180ms ease, clip-path 180ms ease, opacity 180ms ease"
      />
      {family !== "cut" ? <Box position="absolute" left="50%" top="0" bottom="0" w="1px" bg="studio.fgSubtle" /> : null}
    </Box>
  );
}

function DurationControl({ value, max, onChange, label }: { value: number; max: number; onChange: (value: number) => void; label: string }) {
  return (
    <Box>
      <Flex align="center" justify="space-between" mb="8px">
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted">{label}</Text>
        <Text fontSize="13px" color="studio.fg" fontVariantNumeric="tabular-nums">{value.toFixed(2)}s</Text>
      </Flex>
      <Slider.Root aria-label={[label]} value={[value]} min={0.1} max={max} step={0.05} onValueChange={(event) => onChange(event.value[0]!)} size="sm" css={studioSliderCss}>
        <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
      </Slider.Root>
      <Flex justify="space-between" mt="4px">
        <Text fontSize="12px" color="studio.fgSubtle" fontVariantNumeric="tabular-nums">0.10s</Text>
        <Text fontSize="12px" color="studio.fgSubtle" fontVariantNumeric="tabular-nums">{max.toFixed(2)}s</Text>
      </Flex>
    </Box>
  );
}

function SecondaryButton({ children, disabled = false, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <PanelButton disabled={disabled} onClick={onClick}>
      {children}
    </PanelButton>
  );
}

export function TransitionsPanel() {
  const studio = useStudio(
    "studioEdits",
    "setStudioEdits",
    "clipInfo",
    "editorDocument",
    "setMotionPreview",
    "sceneBlocks",
    "updateSceneMotion",
    "upsertMediaMotion",
    "upgradePrompts",
  );
  const { openUpgrade } = useUpgrade();
  const { studioEdits, setStudioEdits, clipInfo, editorDocument, setMotionPreview, upgradePrompts } = studio;
  const motionPrompt = upgradePrompts.motion;
  const [tab, setTab] = useState<MotionTab>("transition");
  const [selected, setSelected] = useState(studioEdits.transition.type);
  const [duration, setDuration] = useState(studioEdits.transition.durationSec);
  const [applyState, setApplyState] = useState<"idle" | "applying" | "applied" | "error">("idle");
  const mediaTargets = useMemo(
    () => [
      ...(editorDocument.brollUrl ? [{ id: "broll", label: "Manual B-roll", kind: "broll" as const }] : []),
      ...studio.sceneBlocks.map((scene, index) => ({ id: scene.id, label: `Scene ${index + 1} · ${scene.content.kind}`, kind: "scene" as const })),
    ],
    [editorDocument.brollUrl, studio.sceneBlocks],
  );
  const [targetId, setTargetId] = useState(mediaTargets[0]?.id ?? "");
  const target = mediaTargets.find((candidate) => candidate.id === targetId) ?? mediaTargets[0] ?? null;
  const selectedScene = target?.kind === "scene" ? studio.sceneBlocks.find((scene) => scene.id === target.id) ?? null : null;
  const brollMotion = editorDocument.mediaMotions.find((motion) => motion.target.kind === "broll" && motion.enabled);
  const currentMediaMotion = selectedScene?.motion ?? brollMotion ?? { entrance: "fade" as const, exit: "fade" as const, durationSec: 0.5 };
  const [mediaEntrance, setMediaEntrance] = useState<SceneMotion["entrance"]>(currentMediaMotion.entrance);
  const [mediaExit, setMediaExit] = useState<SceneMotion["exit"]>(currentMediaMotion.exit);
  const [mediaDuration, setMediaDuration] = useState(currentMediaMotion.durationSec);
  const canPersist = clipInfo.canPersistMotion;

  function chooseTarget(id: string) {
    setTargetId(id);
    const nextTarget = mediaTargets.find((candidate) => candidate.id === id);
    const scene = nextTarget?.kind === "scene" ? studio.sceneBlocks.find((candidate) => candidate.id === id) : null;
    const motion = scene?.motion ?? brollMotion ?? { entrance: "fade" as const, exit: "fade" as const, durationSec: 0.5 };
    setMediaEntrance(motion.entrance);
    setMediaExit(motion.exit);
    setMediaDuration(motion.durationSec);
  }

  function applyMediaMotion() {
    if (!target) return;
    if (!canPersist) {
      if (target.kind === "scene") {
        setMotionPreview({
          kind: "scene",
          sceneBlockId: target.id,
          motion: { entrance: mediaEntrance, exit: mediaExit, durationSec: mediaDuration },
        });
      } else {
        const totalDuration = clipInfo.duration + studio.sceneBlocks.reduce((sum, scene) => sum + scene.durationSec, 0);
        const previewMotion: MediaMotion = {
          schemaVersion: 1,
          id: brollMotion?.id ?? crypto.randomUUID(),
          target: { kind: "broll" },
          startSec: 0,
          endSec: Math.max(0.1, totalDuration),
          entrance: mediaEntrance,
          exit: mediaExit,
          durationSec: mediaDuration,
          enabled: true,
        };
        setMotionPreview({ kind: "broll", motion: previewMotion });
      }
      toaster.create({ type: "info", title: "Previewing motion", description: "Upgrade to Creator to save and export it." });
      return;
    }
    setMotionPreview(null);
    if (target.kind === "scene") {
      studio.updateSceneMotion(target.id, { entrance: mediaEntrance, exit: mediaExit, durationSec: mediaDuration });
    } else {
      const totalDuration = clipInfo.duration + studio.sceneBlocks.reduce((sum, scene) => sum + scene.durationSec, 0);
      const motion: MediaMotion = {
        schemaVersion: 1,
        id: brollMotion?.id ?? crypto.randomUUID(),
        target: { kind: "broll" },
        startSec: 0,
        endSec: Math.max(0.1, totalDuration),
        entrance: mediaEntrance,
        exit: mediaExit,
        durationSec: mediaDuration,
        enabled: true,
      };
      studio.upsertMediaMotion(motion);
    }
    toaster.create({ type: "success", title: "Media motion applied" });
  }

  function applyTransitionToClip() {
    const transition = { type: selected, durationSec: duration };
    if (!canPersist) {
      setMotionPreview({ kind: "transition", transition });
      toaster.create({ type: "info", title: "Previewing transition", description: "Upgrade to Creator to save and export it." });
      return;
    }
    setMotionPreview(null);
    setStudioEdits((previous) => ({ ...previous, transition }));
  }

  async function handleApplyToAll() {
    if (applyState === "applying" || !canPersist) return;
    setStudioEdits((previous) => ({ ...previous, transition: { type: selected, durationSec: duration } }));
    setApplyState("applying");
    try {
      const response = await fetch(`/api/projects/${clipInfo.projectId}/clips/apply-studio-edits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patches: [{ transition: { type: selected, durationSec: duration } }], excludeClipId: clipInfo.id }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as BrowserRequestFailure | null;
        const upgrade = failure ? upgradePromptFromFailure(failure) : null;
        if (upgrade) openUpgrade(upgrade);
        throw new Error("apply failed");
      }
      const data = (await response.json()) as { updated: number };
      setApplyState("applied");
      toaster.create({ type: "success", title: data.updated > 0 ? `Applied to ${data.updated} other clip${data.updated === 1 ? "" : "s"}` : "Every other clip already matches" });
      setTimeout(() => setApplyState("idle"), 2_000);
    } catch {
      setApplyState("error");
      toaster.create({ type: "error", title: "Couldn't apply to all clips", description: "No other clip was changed. Try again." });
      setTimeout(() => setApplyState("idle"), 3_000);
    }
  }

  return (
    <Stack gap="0">
      <PanelTabs
        ariaLabel="Motion"
        items={[
          { id: "transition", label: "Clip transition", icon: <Zap size={14} /> },
          { id: "media", label: "Selected media", icon: <Move size={14} /> },
        ]}
        value={tab}
        onChange={setTab}
      />
    <Stack gap="20px" px="20px" pt="16px" pb="20px">

      {tab === "transition" ? (
        <>
          <Box>
            <Flex align="baseline" justify="space-between" mb="10px"><Text fontSize="13px" fontWeight="500" color="studio.fgMuted">Preset</Text><Text fontSize="11px" color="studio.fgSubtle">Linear timing</Text></Flex>
            <Box display="grid" gridTemplateColumns="repeat(3, minmax(0, 1fr))" gap="8px">
              {TRANSITIONS.map((transition) => {
                const active = selected === transition.id;
                return (
                  <Box key={transition.id} as="button" overflow="hidden" p="6px" {...tileProps(active)} aria-label={`${transition.label} transition`} aria-pressed={active} onClick={() => setSelected(transition.id)}>
                    <PresetPreview family={transition.family} />
                    <Text pt="6px" fontSize="12px" lineHeight="1.2" color={active ? "studio.fg" : "studio.fgMuted"} fontWeight="500">{transition.label}</Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
          <DurationControl value={duration} max={1.5} onChange={setDuration} label="Transition duration" />
          <SecondaryButton onClick={applyTransitionToClip}><Zap size={13} /> {canPersist ? "Apply to this clip" : "Preview on this clip"}</SecondaryButton>
          {!canPersist && motionPrompt?.tier ? (
            <SecondaryButton onClick={() => openUpgrade(motionPrompt)}>
              <Layers size={13} />Apply to all clips<StudioLockGem tier={motionPrompt.tier} />
            </SecondaryButton>
          ) : (
            <SecondaryButton disabled={!canPersist || applyState === "applying"} onClick={handleApplyToAll}>
              <Layers size={13} />{applyState === "applying" ? "Applying…" : applyState === "applied" ? "Applied to all clips" : applyState === "error" ? "Try apply to all again" : "Apply to all clips"}
            </SecondaryButton>
          )}
          <Text fontSize="12px" color="studio.fgSubtle" lineHeight="1.5">Need a subset? Use <Text as="span" color="studio.accentFg" textDecoration="underline"><Link href={`/projects/${clipInfo.projectId}`}>campaign selection</Link></Text> from the Clips view.</Text>
        </>
      ) : target ? (
            <>
              <Box>
                <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="7px">Target</Text>
                <NativeSelect.Root size="sm"><NativeSelect.Field aria-label="Motion target" value={target.id} onChange={(event) => chooseTarget(event.currentTarget.value)} bg="studio.subtle" borderWidth="0" borderRadius="10px" h="40px">{mediaTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root>
              </Box>
              <Flex gap="8px">
                <Box flex="1"><Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="7px">Entrance</Text><NativeSelect.Root size="sm"><NativeSelect.Field aria-label="Entrance motion" value={mediaEntrance} onChange={(event) => setMediaEntrance(event.currentTarget.value as SceneMotion["entrance"])} bg="studio.subtle" borderWidth="0" borderRadius="10px" h="40px">{ENTRANCES.map((motion) => <option key={motion.id} value={motion.id}>{motion.label}</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
                <Box flex="1"><Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="7px">Exit</Text><NativeSelect.Root size="sm"><NativeSelect.Field aria-label="Exit motion" value={mediaExit} onChange={(event) => setMediaExit(event.currentTarget.value as SceneMotion["exit"])} bg="studio.subtle" borderWidth="0" borderRadius="10px" h="40px">{EXITS.map((motion) => <option key={motion.id} value={motion.id}>{motion.label}</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
              </Flex>
              <DurationControl value={mediaDuration} max={2} onChange={setMediaDuration} label="Motion duration" />
              <SecondaryButton onClick={applyMediaMotion}><Sparkles size={13} /> {canPersist ? "Apply media motion" : "Preview media motion"}</SecondaryButton>
            </>
      ) : (
            <Box bg="studio.subtle" borderRadius="10px" p="16px"><Text fontSize="14px" color="studio.fg" fontWeight="500">No media target yet</Text><Text mt="4px" fontSize="13px" color="studio.fgMuted" lineHeight="1.5">Add manual B-roll or a Scene Block, then return here to animate it.</Text></Box>
      )}

      {!canPersist ? (
        <Box bg="studio.subtle" borderRadius="10px" p="16px">
          <Text fontSize="14px" color="studio.fg" fontWeight="500">Motion preview is available</Text>
          <Text mt="4px" fontSize="13px" color="studio.fgMuted" lineHeight="1.5">Saving motion and including it in exports needs {motionPrompt?.tier ? PLAN_CATALOG[motionPrompt.tier].name : "a higher plan"}.</Text>
          {motionPrompt?.tier ? (
            <Box as="button" mt="8px" fontSize="13px" color="upgrade.fg" textDecoration="underline" textUnderlineOffset="3px" cursor="pointer" aria-haspopup="dialog" onClick={() => openUpgrade(motionPrompt)}>
              See what {PLAN_CATALOG[motionPrompt.tier].name} adds
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Stack>
    </Stack>
  );
}
