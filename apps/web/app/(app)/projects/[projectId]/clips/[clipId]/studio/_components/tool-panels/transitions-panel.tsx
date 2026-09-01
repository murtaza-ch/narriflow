"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Box, Flex, NativeSelect, Slider, Stack, Text } from "@chakra-ui/react";
import { Layers, Move, Sparkles, Zap } from "lucide-react";
import { toaster } from "@narriflow/ui";
import type { MediaMotion, SceneMotion, StudioEdits } from "@narriflow/validators";
import { useStudio } from "../studio-shell";

type TransitionType = StudioEdits["transition"]["type"];
type MotionTab = "transition" | "media";

const TRANSITIONS: ReadonlyArray<{
  id: TransitionType;
  label: string;
  family: "cut" | "fade" | "wipe" | "slide" | "zoom";
}> = [
  { id: "none", label: "Cut", family: "cut" },
  { id: "fade", label: "Fade", family: "fade" },
  { id: "cross-dissolve", label: "Dissolve", family: "fade" },
  { id: "fade-black", label: "Fade black", family: "fade" },
  { id: "dip-white", label: "Dip white", family: "fade" },
  { id: "wipe-left", label: "Wipe left", family: "wipe" },
  { id: "wipe-right", label: "Wipe right", family: "wipe" },
  { id: "wipe-up", label: "Wipe up", family: "wipe" },
  { id: "wipe-down", label: "Wipe down", family: "wipe" },
  { id: "slide-left", label: "Slide left", family: "slide" },
  { id: "slide-right", label: "Slide right", family: "slide" },
  { id: "slide-up", label: "Slide up", family: "slide" },
  { id: "slide-down", label: "Slide down", family: "slide" },
  { id: "zoom-in", label: "Zoom in", family: "zoom" },
  { id: "zoom-out", label: "Zoom out", family: "zoom" },
];

const ENTRANCES: ReadonlyArray<{ id: SceneMotion["entrance"]; label: string }> = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade" },
  { id: "scale-in", label: "Scale in" },
  { id: "pan-left", label: "Pan left" },
  { id: "pan-right", label: "Pan right" },
  { id: "pan-up", label: "Pan up" },
  { id: "pan-down", label: "Pan down" },
  { id: "ken-burns-in", label: "Ken Burns in" },
];

const EXITS: ReadonlyArray<{ id: SceneMotion["exit"]; label: string }> = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade" },
  { id: "scale-out", label: "Scale out" },
  { id: "pan-left", label: "Pan left" },
  { id: "pan-right", label: "Pan right" },
  { id: "pan-up", label: "Pan up" },
  { id: "pan-down", label: "Pan down" },
  { id: "ken-burns-out", label: "Ken Burns out" },
];

function PresetPreview({ family }: { family: (typeof TRANSITIONS)[number]["family"] }) {
  return (
    <Box position="relative" w="full" h="34px" overflow="hidden" bg="studio.canvas" borderBottomWidth="1px" borderColor="studio.border">
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
      {family !== "cut" ? <Box position="absolute" left="50%" top="0" bottom="0" w="1px" bg="studio.accent" opacity="0.72" /> : null}
    </Box>
  );
}

function DurationControl({ value, max, onChange, label }: { value: number; max: number; onChange: (value: number) => void; label: string }) {
  return (
    <Box>
      <Flex align="center" justify="space-between" mb="8px">
        <Text textStyle="eyebrow" color="studio.fgMuted">{label}</Text>
        <Text textStyle="data" fontSize="11px" color="studio.timecode">{value.toFixed(2)}s</Text>
      </Flex>
      <Slider.Root aria-label={[label]} value={[value]} min={0.1} max={max} step={0.05} onValueChange={(event) => onChange(event.value[0]!)} size="sm" colorPalette="accent">
        <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
      </Slider.Root>
      <Flex justify="space-between" mt="4px">
        <Text textStyle="data" fontSize="10px" color="studio.fgSubtle">0.10s</Text>
        <Text textStyle="data" fontSize="10px" color="studio.fgSubtle">{max.toFixed(2)}s</Text>
      </Flex>
    </Box>
  );
}

function SecondaryButton({ children, disabled = false, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <Flex
      as="button"
      align="center"
      justify="center"
      h="34px"
      borderRadius="l2"
      bg="studio.raised"
      borderWidth="1px"
      borderColor="studio.borderStrong"
      color={disabled ? "studio.fgDisabled" : "studio.fg"}
      fontSize="12px"
      fontWeight="600"
      cursor={disabled ? "not-allowed" : "pointer"}
      opacity={disabled ? 0.58 : 1}
      gap="6px"
      _hover={disabled ? {} : { borderColor: "studio.fgSubtle" }}
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled}
    >
      {children}
    </Flex>
  );
}

export function TransitionsPanel() {
  const studio = useStudio();
  const { studioEdits, setStudioEdits, clipInfo, editorDocument } = studio;
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
    if (!target || !canPersist) return;
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
      if (!response.ok) throw new Error("apply failed");
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
    <Stack gap="16px" p="12px">
      <Flex p="3px" bg="studio.subtle" borderWidth="1px" borderColor="studio.border" borderRadius="l2">
        {([["transition", "Clip transition", Zap], ["media", "Selected media", Move]] as const).map(([id, label, Icon]) => (
          <Flex key={id} as="button" flex="1" h="30px" align="center" justify="center" gap="5px" borderRadius="l1" bg={tab === id ? "studio.raised" : "transparent"} color={tab === id ? "studio.fg" : "studio.fgMuted"} borderWidth="1px" borderColor={tab === id ? "studio.borderStrong" : "transparent"} fontSize="11px" fontWeight="600" aria-pressed={tab === id} onClick={() => setTab(id)}>
            <Icon size={12} /> {label}
          </Flex>
        ))}
      </Flex>

      {tab === "transition" ? (
        <>
          <Box>
            <Flex align="baseline" justify="space-between" mb="9px"><Text textStyle="eyebrow" color="studio.fgMuted">Preset</Text><Text fontSize="10px" color="studio.fgSubtle">Linear timing</Text></Flex>
            <Box display="grid" gridTemplateColumns="repeat(3, minmax(0, 1fr))" gap="6px">
              {TRANSITIONS.map((transition) => {
                const active = selected === transition.id;
                return (
                  <Box key={transition.id} as="button" overflow="hidden" borderRadius="l2" bg={active ? "studio.raised" : "studio.subtle"} borderWidth="1px" borderColor={active ? "studio.accent" : "studio.border"} cursor="pointer" aria-label={`${transition.label} transition`} aria-pressed={active} onClick={() => setSelected(transition.id)} _hover={{ borderColor: active ? "studio.accent" : "studio.borderStrong" }}>
                    <PresetPreview family={transition.family} />
                    <Text px="4px" py="6px" fontSize="9.5px" lineHeight="1.1" color={active ? "studio.accentFg" : "studio.fgMuted"} fontWeight="600">{transition.label}</Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
          <DurationControl value={duration} max={1.5} onChange={setDuration} label="Transition duration" />
          <SecondaryButton disabled={!canPersist} onClick={() => setStudioEdits((previous) => ({ ...previous, transition: { type: selected, durationSec: duration } }))}><Zap size={13} /> Apply to this clip</SecondaryButton>
          <SecondaryButton disabled={!canPersist || applyState === "applying"} onClick={handleApplyToAll}>
            <Layers size={13} />{applyState === "applying" ? "Applying…" : applyState === "applied" ? "Applied to all clips" : applyState === "error" ? "Try apply to all again" : "Apply to all clips"}
          </SecondaryButton>
          <Text fontSize="10.5px" color="studio.fgSubtle" lineHeight="1.45">Need a subset? Use <Text as="span" color="studio.accentFg" textDecoration="underline"><Link href={`/projects/${clipInfo.projectId}`}>campaign selection</Link></Text> from the Clips view.</Text>
        </>
      ) : target ? (
            <>
              <Box>
                <Text textStyle="eyebrow" color="studio.fgMuted" mb="7px">Target</Text>
                <NativeSelect.Root size="sm"><NativeSelect.Field aria-label="Motion target" value={target.id} onChange={(event) => chooseTarget(event.currentTarget.value)} bg="studio.subtle" borderColor="studio.borderStrong">{mediaTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root>
              </Box>
              <Flex gap="8px">
                <Box flex="1"><Text textStyle="eyebrow" color="studio.fgMuted" mb="7px">Entrance</Text><NativeSelect.Root size="sm"><NativeSelect.Field aria-label="Entrance motion" value={mediaEntrance} onChange={(event) => setMediaEntrance(event.currentTarget.value as SceneMotion["entrance"])} bg="studio.subtle" borderColor="studio.borderStrong">{ENTRANCES.map((motion) => <option key={motion.id} value={motion.id}>{motion.label}</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
                <Box flex="1"><Text textStyle="eyebrow" color="studio.fgMuted" mb="7px">Exit</Text><NativeSelect.Root size="sm"><NativeSelect.Field aria-label="Exit motion" value={mediaExit} onChange={(event) => setMediaExit(event.currentTarget.value as SceneMotion["exit"])} bg="studio.subtle" borderColor="studio.borderStrong">{EXITS.map((motion) => <option key={motion.id} value={motion.id}>{motion.label}</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
              </Flex>
              <DurationControl value={mediaDuration} max={2} onChange={setMediaDuration} label="Motion duration" />
              <SecondaryButton disabled={!canPersist} onClick={applyMediaMotion}><Sparkles size={13} /> Apply media motion</SecondaryButton>
            </>
      ) : (
            <Box layerStyle="well" p="14px"><Text fontSize="12px" color="studio.fg" fontWeight="600">No media target yet</Text><Text mt="4px" fontSize="10.5px" color="studio.fgMuted" lineHeight="1.45">Add manual B-roll or a Scene Block, then return here to animate it.</Text></Box>
      )}

      {!canPersist ? (
        <Box borderLeftWidth="3px" borderColor="studio.accent" bg="studio.subtle" p="10px">
          <Text fontSize="11px" color="studio.fg" fontWeight="600">Motion preview is available</Text>
          <Text mt="3px" fontSize="10px" color="studio.fgMuted" lineHeight="1.4">Creator and higher plans can save motion and include it in exports. <Text as="span" color="studio.accentFg" textDecoration="underline"><Link href="/settings/billing">View plans</Link></Text></Text>
        </Box>
      ) : null}
    </Stack>
  );
}
