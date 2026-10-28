"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Global } from "@emotion/react";
import { Box, Button, Flex, NativeSelect, Slider, Stack, Text } from "@chakra-ui/react";
import {
  PANEL_PX,
  PanelButton,
  PanelEmpty,
  PanelTabs,
  SectionLabel,
  SelectedCheck,
  softButtonProps,
  studioSliderCss,
  tileProps,
} from "./panel-ui";
import { Layers, Move, Sparkles, Zap } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import { PLAN_CATALOG, type MediaMotion, type SceneMotion, type StudioTransition } from "@narriflow/validators";
import {
  MOTION_ENTRANCE_OPTIONS,
  MOTION_EXIT_OPTIONS,
  TRANSITION_OPTIONS,
} from "@/lib/motion-options";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
import { createClipsClient, invalidateAfterClipChange } from "@narriflow/api-client/clips";
import { apiFailureBody, requireStudioApi } from "../studio-api";
import { useStudioApi } from "../use-studio-api";
import { useUpgrade } from "@/app/(app)/_components/upgrade";
import { useStudio } from "../studio-shell";
import { StudioLockGem } from "../studio-lock-gem";

type MotionTab = "transition" | "media";

const TRANSITIONS = TRANSITION_OPTIONS.map((option) => ({
  id: option.value,
  label: option.shortLabel,
}));
const ENTRANCES = MOTION_ENTRANCE_OPTIONS.map((option) => ({ id: option.value, label: option.label }));
const EXITS = MOTION_EXIT_OPTIONS.map((option) => ({ id: option.value, label: option.label }));

// Each tile stages the transition between two stand-in shots: A (neutral) and
// B (accent). At rest the tile holds a mid-transition frame; on hover/focus it
// plays A -> B and back, and the chosen tile loops. Reduced motion keeps the
// still frame. A pose is the resting style, a keyframes name the motion; the
// animation overrides the pose while it runs, so every frame sets what it moves.
const LEG = "0%, 16%";
const END = "84%, 100%";
const MOTION_KEYFRAMES = {
  "@keyframes nf-tx-cut": { "0%, 49%": { opacity: 0, clipPath: "inset(0)" }, "50%, 100%": { opacity: 1, clipPath: "inset(0)" } },
  "@keyframes nf-tx-fade": { [LEG]: { opacity: 0 }, [END]: { opacity: 1 } },
  "@keyframes nf-tx-dip-b": { "0%, 44%": { opacity: 0, clipPath: "inset(0)" }, "56%, 100%": { opacity: 1, clipPath: "inset(0)" } },
  "@keyframes nf-tx-dip": { "0%, 10%": { opacity: 0 }, "50%": { opacity: 1 }, "90%, 100%": { opacity: 0 } },
  "@keyframes nf-tx-wipe-left": { [LEG]: { clipPath: "inset(0 0 0 100%)" }, [END]: { clipPath: "inset(0 0 0 0)" } },
  "@keyframes nf-tx-wipe-right": { [LEG]: { clipPath: "inset(0 100% 0 0)" }, [END]: { clipPath: "inset(0 0 0 0)" } },
  "@keyframes nf-tx-wipe-up": { [LEG]: { clipPath: "inset(100% 0 0 0)" }, [END]: { clipPath: "inset(0 0 0 0)" } },
  "@keyframes nf-tx-wipe-down": { [LEG]: { clipPath: "inset(0 0 100% 0)" }, [END]: { clipPath: "inset(0 0 0 0)" } },
  "@keyframes nf-tx-in-from-right": { [LEG]: { transform: "translateX(100%)" }, [END]: { transform: "translateX(0)" } },
  "@keyframes nf-tx-in-from-left": { [LEG]: { transform: "translateX(-100%)" }, [END]: { transform: "translateX(0)" } },
  "@keyframes nf-tx-in-from-bottom": { [LEG]: { transform: "translateY(100%)" }, [END]: { transform: "translateY(0)" } },
  "@keyframes nf-tx-in-from-top": { [LEG]: { transform: "translateY(-100%)" }, [END]: { transform: "translateY(0)" } },
  "@keyframes nf-tx-out-to-left": { [LEG]: { transform: "translateX(0)" }, [END]: { transform: "translateX(-100%)" } },
  "@keyframes nf-tx-out-to-right": { [LEG]: { transform: "translateX(0)" }, [END]: { transform: "translateX(100%)" } },
  "@keyframes nf-tx-out-to-top": { [LEG]: { transform: "translateY(0)" }, [END]: { transform: "translateY(-100%)" } },
  "@keyframes nf-tx-out-to-bottom": { [LEG]: { transform: "translateY(0)" }, [END]: { transform: "translateY(100%)" } },
  "@keyframes nf-tx-grow": { [LEG]: { transform: "scale(0.5)" }, [END]: { transform: "scale(1)" } },
  "@keyframes nf-tx-shrink": { [LEG]: { transform: "scale(1)" }, [END]: { transform: "scale(0.5)" } },
};

type Shot = { pose?: React.CSSProperties; animation?: string };
type Demo = { a?: Shot; b: Shot; dip?: Shot & { color: "studio.canvas" | "studio.fg" }; aOnTop?: boolean };

const wipe = (direction: "left" | "right" | "up" | "down", pose: string): Demo => ({
  b: { pose: { clipPath: pose }, animation: `nf-tx-wipe-${direction}` },
});
const slide = (
  pose: { a: string; b: string },
  anim: { a: string; b: string },
): Demo => ({
  a: { pose: { transform: pose.a }, animation: anim.a },
  b: { pose: { transform: pose.b }, animation: anim.b },
});

const DEMOS: Record<StudioTransition["type"], Demo> = {
  none: { b: { pose: { clipPath: "inset(0 0 0 50%)" }, animation: "nf-tx-cut" } },
  fade: { b: { pose: { opacity: 0.5 }, animation: "nf-tx-fade" } },
  "fade-black": { b: { pose: { clipPath: "inset(0 0 0 50%)" }, animation: "nf-tx-dip-b" }, dip: { color: "studio.canvas", pose: { opacity: 0.55 }, animation: "nf-tx-dip" } },
  "dip-white": { b: { pose: { clipPath: "inset(0 0 0 50%)" }, animation: "nf-tx-dip-b" }, dip: { color: "studio.fg", pose: { opacity: 0.55 }, animation: "nf-tx-dip" } },
  "wipe-left": wipe("left", "inset(0 0 0 50%)"),
  "wipe-right": wipe("right", "inset(0 50% 0 0)"),
  "wipe-up": wipe("up", "inset(50% 0 0 0)"),
  "wipe-down": wipe("down", "inset(0 0 50% 0)"),
  "slide-left": slide({ a: "translateX(-50%)", b: "translateX(50%)" }, { a: "nf-tx-out-to-left", b: "nf-tx-in-from-right" }),
  "slide-right": slide({ a: "translateX(50%)", b: "translateX(-50%)" }, { a: "nf-tx-out-to-right", b: "nf-tx-in-from-left" }),
  "slide-up": slide({ a: "translateY(-50%)", b: "translateY(50%)" }, { a: "nf-tx-out-to-top", b: "nf-tx-in-from-bottom" }),
  "slide-down": slide({ a: "translateY(50%)", b: "translateY(-50%)" }, { a: "nf-tx-out-to-bottom", b: "nf-tx-in-from-top" }),
  "zoom-in": { b: { pose: { transform: "scale(0.55)" }, animation: "nf-tx-grow" } },
  "zoom-out": { a: { pose: { transform: "scale(0.55)" }, animation: "nf-tx-shrink" }, b: {}, aOnTop: true },
};

const PLAY_ON_HOVER = {
  "@media (prefers-reduced-motion: no-preference)": {
    "&:hover [data-shot], &:focus-visible [data-shot], &[aria-pressed=true] [data-shot]": {
      animationDuration: "1.1s",
      animationIterationCount: "infinite",
      animationDirection: "alternate",
      animationTimingFunction: "cubic-bezier(0.65, 0, 0.35, 1)",
    },
  },
} as const;

function ShotLayer({ bg, glyph, shot, z = 0, dim = false }: { bg: string; glyph: string; shot?: Shot; z?: number; dim?: boolean }) {
  return (
    <Box
      data-shot
      position="absolute"
      inset="0"
      display="flex"
      alignItems="center"
      justifyContent="center"
      bg={bg}
      zIndex={z}
      filter={dim ? "brightness(0.78)" : undefined}
      style={{ ...shot?.pose, animationName: shot?.animation }}
    >
      <Box boxSize="14px" borderRadius="full" bg={glyph} />
    </Box>
  );
}

function PresetPreview({ type }: { type: StudioTransition["type"] }) {
  const demo = DEMOS[type];
  return (
    <Box position="relative" w="full" h="48px" overflow="hidden" bg="studio.canvas" borderRadius="8px" aria-hidden>
      <ShotLayer bg="studio.raised" glyph="studio.borderStrong" shot={demo.a} z={demo.aOnTop ? 2 : 0} />
      <ShotLayer bg="studio.accent" glyph="studio.accentSubtle" shot={demo.b} z={1} dim />
      {demo.dip ? (
        <Box data-shot position="absolute" inset="0" bg={demo.dip.color} zIndex={2} style={{ ...demo.dip.pose, animationName: demo.dip.animation }} />
      ) : null}
    </Box>
  );
}

function DurationControl({ value, max, onChange, label }: { value: number; max: number; onChange: (value: number) => void; label: string }) {
  return (
    <Box>
      <SectionLabel
        action={
          <Text fontSize="13px" color="studio.fg" fontVariantNumeric="tabular-nums">
            {value.toFixed(2)}s
          </Text>
        }
      >
        {label}
      </SectionLabel>
      <Slider.Root aria-label={[label]} value={[value]} min={0.1} max={max} step={0.05} onValueChange={(event) => onChange(event.value[0]!)} size="sm" css={studioSliderCss}>
        <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
      </Slider.Root>
    </Box>
  );
}

// The tab's one solid action; the quieter siblings use PanelButton.
function PrimaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <Button w="full" h="44px" borderRadius="10px" fontSize="14px" fontWeight="500" colorPalette="brand" onClick={onClick}>
      {children}
    </Button>
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
    "setActiveTool",
  );
  const { openUpgrade } = useUpgrade();
  const studioApi = useStudioApi();
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
  const lockedPreviewCopy = motionPrompt?.tier
    ? `Upgrade to ${PLAN_CATALOG[motionPrompt.tier].name} to save and export it.`
    : "Saving and exporting motion isn't available on this plan.";

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
    // Turning motion off is cleanup any plan may save.
    if (!canPersist && !(mediaEntrance === "none" && mediaExit === "none")) {
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
      toaster.create({ type: "info", title: "Previewing motion", description: lockedPreviewCopy });
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
    // A cut (no transition) is cleanup any plan may save.
    if (!canPersist && selected !== "none") {
      setMotionPreview({ kind: "transition", transition });
      toaster.create({ type: "info", title: "Previewing transition", description: lockedPreviewCopy });
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
      const api = requireStudioApi(studioApi);
      let data: { updated: number };
      try {
        const response = await createClipsClient(api.runtime.transport.scoped(api.scope)).projects[":id"].clips[
          "apply-studio-edits"
        ].$post({
          param: { id: clipInfo.projectId },
          json: { patches: [{ transition: { type: selected, durationSec: duration } }], excludeClipId: clipInfo.id },
        });
        data = (await response.json()) as { updated: number };
      } catch (error) {
        const upgrade = upgradePromptFromFailure(apiFailureBody(error));
        if (upgrade) openUpgrade(upgrade);
        throw new Error("apply failed");
      }
      void invalidateAfterClipChange(api.runtime.queryClient, api.scope, clipInfo.projectId);
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
      <Global styles={MOTION_KEYFRAMES} />
      <PanelTabs
        ariaLabel="Motion"
        items={[
          { id: "transition", label: "Clip transition", icon: <Zap size={14} /> },
          { id: "media", label: "Selected media", icon: <Move size={14} /> },
        ]}
        value={tab}
        onChange={setTab}
      />
    <Stack gap="5" px={PANEL_PX} pt="4" pb="5">

      {tab === "transition" ? (
        <>
          <Box>
            <SectionLabel action={<Text fontSize="11px" color="studio.fgSubtle">Linear timing</Text>}>Preset</SectionLabel>
            <Box display="grid" gridTemplateColumns="repeat(3, minmax(0, 1fr))" gap="2">
              {TRANSITIONS.map((transition) => {
                const active = selected === transition.id;
                return (
                  <Box key={transition.id} as="button" p="6px" pb="2" css={PLAY_ON_HOVER} {...tileProps(active)} aria-label={`${transition.label} transition`} aria-pressed={active} onClick={() => setSelected(transition.id)}>
                    <PresetPreview type={transition.id} />
                    <Text pt="2" fontSize="12px" lineHeight="1.2" fontWeight="500">{transition.label}</Text>
                    <SelectedCheck show={active} />
                  </Box>
                );
              })}
            </Box>
          </Box>
          <DurationControl value={duration} max={1.5} onChange={setDuration} label="Transition duration" />
          <Stack gap="2">
            <PrimaryButton onClick={applyTransitionToClip}><Zap size={14} /> {canPersist || selected === "none" ? "Apply to this clip" : "Preview on this clip"}</PrimaryButton>
            {!canPersist && motionPrompt?.tier ? (
              <SecondaryButton onClick={() => openUpgrade(motionPrompt)}>
                <Layers size={14} />Apply to all clips<StudioLockGem tier={motionPrompt.tier} />
              </SecondaryButton>
            ) : (
              <SecondaryButton disabled={!canPersist || applyState === "applying"} onClick={handleApplyToAll}>
                <Layers size={14} />{applyState === "applying" ? "Applying…" : applyState === "applied" ? "Applied to all clips" : applyState === "error" ? "Try apply to all again" : "Apply to all clips"}
              </SecondaryButton>
            )}
          </Stack>
          <Text fontSize="12px" color="studio.fgSubtle" lineHeight="1.5">Only some clips? Use <Text as="span" color="studio.accentFg" textDecoration="underline"><Link href={`/projects/${clipInfo.projectId}`}>campaign selection</Link></Text>.</Text>
        </>
      ) : target ? (
            <>
              <Box>
                <SectionLabel>Target</SectionLabel>
                <NativeSelect.Root size="sm"><NativeSelect.Field aria-label="Motion target" value={target.id} onChange={(event) => chooseTarget(event.currentTarget.value)} bg="studio.subtle" borderWidth="0" borderRadius="10px" h="40px">{mediaTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root>
              </Box>
              <Flex gap="2">
                <Box flex="1"><SectionLabel>Entrance</SectionLabel><NativeSelect.Root size="sm"><NativeSelect.Field aria-label="Entrance motion" value={mediaEntrance} onChange={(event) => setMediaEntrance(event.currentTarget.value as SceneMotion["entrance"])} bg="studio.subtle" borderWidth="0" borderRadius="10px" h="40px">{ENTRANCES.map((motion) => <option key={motion.id} value={motion.id}>{motion.label}</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
                <Box flex="1"><SectionLabel>Exit</SectionLabel><NativeSelect.Root size="sm"><NativeSelect.Field aria-label="Exit motion" value={mediaExit} onChange={(event) => setMediaExit(event.currentTarget.value as SceneMotion["exit"])} bg="studio.subtle" borderWidth="0" borderRadius="10px" h="40px">{EXITS.map((motion) => <option key={motion.id} value={motion.id}>{motion.label}</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Box>
              </Flex>
              <DurationControl value={mediaDuration} max={2} onChange={setMediaDuration} label="Motion duration" />
              <PrimaryButton onClick={applyMediaMotion}><Sparkles size={14} /> {canPersist || (mediaEntrance === "none" && mediaExit === "none") ? "Apply media motion" : "Preview media motion"}</PrimaryButton>
            </>
      ) : (
        <PanelEmpty
          icon={<Move size={18} />}
          title="No media target yet"
          actions={
            <>
              <Button size="xs" {...softButtonProps} onClick={() => studio.setActiveTool("broll")}>Add B-roll</Button>
              <Button size="xs" {...softButtonProps} onClick={() => studio.setActiveTool("scenes")}>Add a scene</Button>
            </>
          }
        >
          Add B-roll or a scene, then return here to animate it.
        </PanelEmpty>
      )}

      {!canPersist ? (
        <Box bg="studio.subtle" borderRadius="12px" p="4">
          <Text fontSize="14px" color="studio.fg" fontWeight="500">Motion preview is available</Text>
          <Text mt="1" fontSize="13px" color="studio.fgMuted" lineHeight="1.5">Saving motion and including it in exports needs {motionPrompt?.tier ? PLAN_CATALOG[motionPrompt.tier].name : "a higher plan"}.</Text>
          {motionPrompt?.tier ? (
            <Box as="button" mt="2" fontSize="13px" color="upgrade.fg" textDecoration="underline" textUnderlineOffset="3px" cursor="pointer" aria-haspopup="dialog" onClick={() => openUpgrade(motionPrompt)}>
              See what {PLAN_CATALOG[motionPrompt.tier].name} adds
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Stack>
    </Stack>
  );
}
