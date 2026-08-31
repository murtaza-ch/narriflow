"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Button, Flex, NativeSelect, Slider, Stack, Text } from "@chakra-ui/react";
import { Layers, Play, Zap } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { toaster } from "@narriflow/ui";
import type {
  MediaMotion,
  SceneMotion,
  StudioTransition,
} from "@narriflow/validators";
import { buildEditedTimeMap } from "@narriflow/validators";
import { formatFractionalDuration } from "@/lib/format";
import { useStudio } from "../studio-shell";
import {
  availableSceneMotionValues,
  availableStudioTransitions,
	brollMotionTargets,
	manualUrlBrollMotionTarget,
} from "../studio-rollout-visibility";

const TRANSITIONS: ReadonlyArray<{
  id: StudioTransition["type"];
  label: string;
}> = [
  { id: "none", label: "Cut" },
  { id: "fade", label: "Fade" },
  { id: "fade-black", label: "Fade to black" },
  { id: "dip-white", label: "Dip white" },
  { id: "cross-dissolve", label: "Cross dissolve" },
  { id: "wipe-left", label: "Wipe left" },
  { id: "wipe-right", label: "Wipe right" },
  { id: "wipe-up", label: "Wipe up" },
  { id: "wipe-down", label: "Wipe down" },
  { id: "slide-left", label: "Slide left" },
  { id: "slide-right", label: "Slide right" },
  { id: "slide-up", label: "Slide up" },
  { id: "slide-down", label: "Slide down" },
  { id: "zoom-in", label: "Zoom in" },
  { id: "zoom-out", label: "Zoom out" },
];

const ENTRANCES: ReadonlyArray<{ id: SceneMotion["entrance"]; label: string }> = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade in" },
  { id: "scale-in", label: "Scale in" },
  { id: "pan-left", label: "Pan left" },
  { id: "pan-right", label: "Pan right" },
  { id: "pan-up", label: "Pan up" },
  { id: "pan-down", label: "Pan down" },
  { id: "ken-burns-in", label: "Ken Burns in" },
];

const EXITS: ReadonlyArray<{ id: SceneMotion["exit"]; label: string }> = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade out" },
  { id: "scale-out", label: "Scale out" },
  { id: "pan-left", label: "Pan left" },
  { id: "pan-right", label: "Pan right" },
  { id: "pan-up", label: "Pan up" },
  { id: "pan-down", label: "Pan down" },
  { id: "ken-burns-out", label: "Ken Burns out" },
];

function MotionSelect<T extends string>({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: T;
  items: ReadonlyArray<{ id: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <Box>
      <Text textStyle="eyebrow" color="studio.fgMuted" mb="1">{label}</Text>
      <NativeSelect.Root size="sm">
        <NativeSelect.Field
          value={value}
          onChange={(event) => onChange(event.currentTarget.value as T)}
          bg="studio.subtle"
          borderColor="studio.borderStrong"
        >
          {items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    </Box>
  );
}

function motionKeyframe(value: SceneMotion["entrance"] | SceneMotion["exit"]) {
  if (value === "fade") return { opacity: 0 };
  if (value === "scale-in") return { scale: 0.92 };
  if (value === "scale-out") return { scale: 1.08 };
  if (value === "ken-burns-in") return { scale: 1 };
  if (value === "ken-burns-out") return { scale: 1.14 };
  if (value === "pan-left") return { x: 16 };
  if (value === "pan-right") return { x: -16 };
  if (value === "pan-up") return { y: 16 };
  if (value === "pan-down") return { y: -16 };
  return {};
}

function MotionPreview({ entrance, exit }: SceneMotion) {
  const reducedMotion = useReducedMotion() ?? false;
  const resting = entrance === "ken-burns-in" || exit === "ken-burns-out"
    ? { opacity: 1, scale: 1.14, x: 0, y: 0 }
    : { opacity: 1, scale: 1, x: 0, y: 0 };
  const start = { ...resting, ...motionKeyframe(entrance) };
  const end = { ...resting, ...motionKeyframe(exit) };
  const frames = reducedMotion ? resting : {
    opacity: [start.opacity, resting.opacity, end.opacity],
    scale: [start.scale, resting.scale, end.scale],
    x: [start.x, resting.x, end.x],
    y: [start.y, resting.y, end.y],
  };
  return (
    <Flex layerStyle="well" h="112px" align="center" justify="center" overflow="hidden" position="relative">
      <motion.div
        animate={frames}
        transition={reducedMotion ? { duration: 0 } : {
          duration: 2.4,
          times: [0, 0.5, 1],
          repeat: Number.POSITIVE_INFINITY,
          repeatDelay: 0.35,
        }}
        style={{ width: "68%", height: "68%", transformOrigin: "center" }}
      >
        <Flex
          w="full"
          h="full"
          align="center"
          justify="center"
          bg="studio.raised"
          borderWidth="1px"
          borderColor="studio.borderStrong"
          borderRadius="l2"
          color="studio.fgMuted"
        >
          <Play size={18} />
        </Flex>
      </motion.div>
      {reducedMotion ? (
        <Text position="absolute" bottom="5px" textStyle="eyebrow" fontSize="8px" color="studio.fgSubtle">
          Static preview
        </Text>
      ) : null}
    </Flex>
  );
}

function TransitionPreview({ type }: { type: StudioTransition["type"] }) {
  const reducedMotion = useReducedMotion() ?? false;
  const direction = type.match(/-(left|right|up|down)$/)?.[1];
  const resting = { opacity: 1, scale: 1, x: 0, y: 0, clipPath: "inset(0 0 0 0)" };
  const animated = type === "none" || reducedMotion
    ? resting
    : {
        opacity: type === "fade" || type === "fade-black" || type === "dip-white" || type === "cross-dissolve"
          ? [0, 1, 1, 0]
          : 1,
        scale: type === "zoom-in"
          ? [0.88, 1, 1.12]
          : type === "zoom-out"
            ? [1.12, 1, 0.88]
            : 1,
        x: type.startsWith("slide-")
          ? [direction === "left" ? 40 : direction === "right" ? -40 : 0, 0, direction === "left" ? -40 : direction === "right" ? 40 : 0]
          : 0,
        y: type.startsWith("slide-")
          ? [direction === "up" ? 40 : direction === "down" ? -40 : 0, 0, direction === "up" ? -40 : direction === "down" ? 40 : 0]
          : 0,
        clipPath: type.startsWith("wipe-")
          ? direction === "left"
            ? ["inset(0 0 0 100%)", "inset(0 0 0 0)", "inset(0 100% 0 0)"]
            : direction === "right"
              ? ["inset(0 100% 0 0)", "inset(0 0 0 0)", "inset(0 0 0 100%)"]
              : direction === "up"
                ? ["inset(100% 0 0 0)", "inset(0 0 0 0)", "inset(0 0 100% 0)"]
                : ["inset(0 0 100% 0)", "inset(0 0 0 0)", "inset(100% 0 0 0)"]
          : resting.clipPath,
      };
  return (
    <Flex layerStyle="well" h="112px" align="center" justify="center" overflow="hidden" position="relative">
      <motion.div
        animate={animated}
        transition={reducedMotion || type === "none" ? { duration: 0 } : {
          duration: 2.4,
          times: type.startsWith("slide-") || type.startsWith("wipe-") || type.startsWith("zoom-")
            ? [0, 0.5, 1]
            : [0, 0.2, 0.8, 1],
          repeat: Number.POSITIVE_INFINITY,
          repeatDelay: 0.35,
        }}
        style={{ width: "68%", height: "68%", transformOrigin: "center" }}
      >
        <Flex
          w="full"
          h="full"
          align="center"
          justify="center"
          bg={type === "dip-white" ? "studio.fg" : "studio.raised"}
          borderWidth="1px"
          borderColor="studio.borderStrong"
          borderRadius="l2"
          color={type === "dip-white" ? "studio.surface" : "studio.fgMuted"}
        >
          <Play size={18} />
        </Flex>
      </motion.div>
      {reducedMotion ? (
        <Text position="absolute" bottom="5px" textStyle="eyebrow" fontSize="8px" color="studio.fgSubtle">
          Static preview
        </Text>
      ) : null}
    </Flex>
  );
}

export function MotionPanel() {
  const studio = useStudio();
  const [tab, setTab] = useState<"clip" | "media">("clip");
  const [selectedTransition, setSelectedTransition] = useState(
    studio.studioEdits.transition.type,
  );
  const [duration, setDuration] = useState(studio.studioEdits.transition.durationSec);
  const transitionItems = useMemo(() => {
    const available = availableStudioTransitions(
      studio.motionRollout,
      studio.studioEdits.transition.type,
    );
    return TRANSITIONS.filter((transition) => available.includes(transition.id));
  }, [studio.motionRollout, studio.studioEdits.transition.type]);
  const releasedTransitions = useMemo(
    () => availableStudioTransitions(studio.motionRollout, "none"),
    [studio.motionRollout],
  );
	const mediaTargets = useMemo(() => [
		...(() => {
			const durationSec = buildEditedTimeMap(
				studio.editorDocument.deletedRanges,
				{
					startSec: studio.editorDocument.clipStartSec,
					endSec: studio.editorDocument.clipEndSec,
				},
			).editedDurationSec;
			const target = manualUrlBrollMotionTarget(
				studio.brollUrl,
				durationSec,
				studio.brollPlacements.length > 0,
			);
			return target ? [{ ...target, kind: "broll_url" as const }] : [];
		})(),
		...brollMotionTargets(studio.brollPlacements).map((target) => ({
			...target,
			kind: "broll" as const,
		})),
    ...studio.sceneBlocks.map((scene, index) => ({
      id: scene.id,
			kind: "scene_block" as const,
			sceneBlockId: scene.id,
			startSec: scene.anchorSec,
			endSec: scene.anchorSec + scene.durationSec,
      label: scene.content.kind === "text"
        ? `Text card · ${scene.content.text.slice(0, 24)}`
        : `Scene ${index + 1} · ${scene.content.kind}`,
    })),
	], [
		studio.brollPlacements,
		studio.brollUrl,
		studio.editorDocument.clipEndSec,
		studio.editorDocument.clipStartSec,
		studio.editorDocument.deletedRanges,
		studio.sceneBlocks,
	]);
  const [targetId, setTargetId] = useState<string>(mediaTargets[0]?.id ?? "");
	const selectedTarget = mediaTargets.find((target) => target.id === targetId) ?? null;
	const targetScene = selectedTarget?.kind === "scene_block"
		? studio.sceneBlocks.find((scene) => scene.id === selectedTarget.sceneBlockId) ?? null
		: null;
	const explicitMotion = selectedTarget
		? studio.editorDocument.mediaMotions.find((candidate) =>
			candidate.target.kind === "broll"
				? selectedTarget.kind === "broll" &&
					candidate.target.placementId === selectedTarget.placementId
				: candidate.target.kind === "broll_url"
					? selectedTarget.kind === "broll_url"
					: selectedTarget.kind === "scene_block" &&
					candidate.target.sceneBlockId === selectedTarget.sceneBlockId,
		)
		: undefined;
  const savedMotion = explicitMotion ?? targetScene?.motion ?? {
    entrance: "none" as const,
    exit: "none" as const,
  };
  const [entrance, setEntrance] = useState<SceneMotion["entrance"]>(savedMotion.entrance);
  const [exit, setExit] = useState<SceneMotion["exit"]>(savedMotion.exit);
  const [applyState, setApplyState] = useState<"idle" | "applying" | "applied" | "error">("idle");
  const entranceItems = useMemo(() => {
    const available = availableSceneMotionValues(
      studio.motionRollout,
      "entrance",
      savedMotion.entrance,
    );
    return ENTRANCES.filter((item) => available.includes(item.id));
  }, [savedMotion.entrance, studio.motionRollout]);
  const exitItems = useMemo(() => {
    const available = availableSceneMotionValues(
      studio.motionRollout,
      "exit",
      savedMotion.exit,
    );
    return EXITS.filter((item) => available.includes(item.id));
  }, [savedMotion.exit, studio.motionRollout]);
  const releasedEntrances = useMemo(
    () => availableSceneMotionValues(studio.motionRollout, "entrance", "none"),
    [studio.motionRollout],
  );
  const releasedExits = useMemo(
    () => availableSceneMotionValues(studio.motionRollout, "exit", "none"),
    [studio.motionRollout],
  );
  const removesTransition = selectedTransition === "none";
  const savedTransitionPaused =
    studio.studioEdits.transition.type !== "none" &&
    !releasedTransitions.includes(studio.studioEdits.transition.type);
  const canApplyTransition =
    removesTransition ||
    (studio.canPersistMotion && releasedTransitions.includes(selectedTransition));
  const removesMediaMotion = entrance === "none" && exit === "none";
  const savedMediaMotionPaused =
    (savedMotion.entrance !== "none" &&
      !releasedEntrances.includes(savedMotion.entrance)) ||
    (savedMotion.exit !== "none" && !releasedExits.includes(savedMotion.exit));
  const canApplyMediaMotion =
    removesMediaMotion ||
    (studio.canPersistMotion &&
      releasedEntrances.includes(entrance) &&
      releasedExits.includes(exit));

  useEffect(() => {
    if (mediaTargets.some((target) => target.id === targetId)) return;
    setTargetId(mediaTargets[0]?.id ?? "");
  }, [mediaTargets, targetId]);
  useEffect(() => {
    setEntrance(savedMotion.entrance);
    setExit(savedMotion.exit);
  }, [savedMotion.entrance, savedMotion.exit]);
  useEffect(() => {
    setSelectedTransition(studio.studioEdits.transition.type);
    setDuration(studio.studioEdits.transition.durationSec);
  }, [
    studio.studioEdits.transition.durationSec,
    studio.studioEdits.transition.type,
  ]);

  const applyClipTransition = () => {
    if (!canApplyTransition) return;
    studio.setStudioEdits((previous) => ({
      ...previous,
      transition: { type: selectedTransition, durationSec: duration },
    }));
  };

  async function handleApplyToAll() {
    if (!canApplyTransition || applyState === "applying") return;
    applyClipTransition();
    setApplyState("applying");
    try {
      const response = await fetch(
        `/api/projects/${studio.clipInfo.projectId}/clips/apply-studio-edits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            patches: [{ transition: { type: selectedTransition, durationSec: duration } }],
            excludeClipId: studio.clipInfo.id,
          }),
        },
      );
      if (!response.ok) throw new Error("apply failed");
      const data = (await response.json()) as { updated: number };
      setApplyState("applied");
      toaster.create({
        type: "success",
        title: data.updated > 0
          ? `Applied to ${data.updated} other clip${data.updated === 1 ? "" : "s"}`
          : "Every other clip already matches",
      });
    } catch {
      setApplyState("error");
      toaster.create({ type: "error", title: "Couldn't apply motion to all clips" });
    } finally {
      window.setTimeout(() => setApplyState("idle"), 2_000);
    }
  }

  const applyMediaMotion = () => {
    if (!canApplyMediaMotion || !targetId) return;
    if (targetScene && !explicitMotion) {
      studio.updateSceneMotion(targetScene.id, { entrance, exit });
      return;
    }
		if (!selectedTarget) return;
    const motionValue: MediaMotion = {
      schemaVersion: 1,
      id: explicitMotion?.id ?? crypto.randomUUID(),
      target: selectedTarget.kind === "scene_block"
				? { kind: "scene_block", sceneBlockId: selectedTarget.sceneBlockId }
				: selectedTarget.kind === "broll_url"
					? { kind: "broll_url" }
					: { kind: "broll", placementId: selectedTarget.placementId },
			startSec: selectedTarget.startSec,
			endSec: selectedTarget.endSec,
      entrance,
      exit,
      enabled: true,
    };
    if (entrance === "none" && exit === "none" && explicitMotion) {
      studio.deleteMediaMotion(explicitMotion.id);
    } else {
      studio.upsertMediaMotion(motionValue);
    }
  };

  return (
    <Stack gap="16px" p="12px">
      <Flex p="2px" bg="studio.subtle" borderWidth="1px" borderColor="studio.border" borderRadius="l1">
        {(["clip", "media"] as const).map((value) => (
          <Button
            key={value}
            flex="1"
            size="xs"
            variant="ghost"
            bg={tab === value ? "studio.raised" : "transparent"}
            color={tab === value ? "studio.accentFg" : "studio.fgMuted"}
            onClick={() => setTab(value)}
          >
            {value === "clip" ? "Clip transition" : "Selected media"}
          </Button>
        ))}
      </Flex>

      {tab === "clip" ? (
        <>
          <Box>
            <Text textStyle="eyebrow" color="studio.fgMuted" mb="10px">Style</Text>
            <Box display="grid" style={{ gridTemplateColumns: "repeat(2, 1fr)", gap: "6px" }}>
              {transitionItems.map((transition) => {
                const active = selectedTransition === transition.id;
                return (
                  <Button
                    key={transition.id}
                    variant="outline"
                    size="sm"
                    h="44px"
                    whiteSpace="normal"
                    borderColor={active ? "studio.accent" : "studio.border"}
                    bg={active ? "studio.raised" : "studio.subtle"}
                    color={active ? "studio.accentFg" : "studio.fgMuted"}
                    aria-pressed={active}
                    onClick={() => setSelectedTransition(transition.id)}
                  >
                    {transition.label}
                  </Button>
                );
              })}
            </Box>
          </Box>
          <TransitionPreview type={selectedTransition} />
          {savedTransitionPaused ? (
            <Box layerStyle="well" p="3">
              <Text fontSize="11px" color="studio.fgMuted">
                This saved transition remains active. Choose Cut to remove it;
                applying it again is temporarily paused.
              </Text>
            </Box>
          ) : null}
          <Box>
            <Flex justify="space-between" mb="8px">
              <Text textStyle="eyebrow" color="studio.fgMuted">Duration</Text>
              <Text textStyle="data" fontSize="11px" color="studio.timecode">{formatFractionalDuration(duration)}</Text>
            </Flex>
            <Slider.Root
              value={[duration]}
              min={0.1}
              max={1.5}
              step={0.05}
              onValueChange={(details) => setDuration(details.value[0]!)}
              size="sm"
              colorPalette="accent"
            >
              <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
            </Slider.Root>
          </Box>
          <Button
            variant="outline"
            borderColor="studio.accent"
            color="studio.accentFg"
            disabled={!canApplyTransition}
            onClick={applyClipTransition}
          >
            <Zap size={13} /> Apply transition
          </Button>
          <Button
            variant="outline"
            disabled={!canApplyTransition || applyState === "applying"}
            onClick={handleApplyToAll}
          >
            <Layers size={13} />
            {applyState === "applying"
              ? "Applying…"
              : applyState === "applied"
                ? "Applied to all clips"
                : applyState === "error"
                  ? "Failed — try again"
                  : "Apply to all clips"}
          </Button>
        </>
      ) : mediaTargets.length === 0 ? (
        <Box layerStyle="well" p="4">
          <Text fontSize="12px" color="studio.fgMuted">
            Add a Scene or manual B-roll, then select it here to apply motion.
          </Text>
        </Box>
      ) : (
        <>
          <MotionSelect label="Media" value={targetId} items={mediaTargets} onChange={setTargetId} />
          <MotionPreview entrance={entrance} exit={exit} />
          {savedMediaMotionPaused ? (
            <Box layerStyle="well" p="3">
              <Text fontSize="11px" color="studio.fgMuted">
                This saved motion remains active. Choose None for both phases
                to remove it; new uses are temporarily paused.
              </Text>
            </Box>
          ) : null}
          <MotionSelect label="Entrance · 0.5s" value={entrance} items={entranceItems} onChange={setEntrance} />
          <MotionSelect label="Exit · 0.5s" value={exit} items={exitItems} onChange={setExit} />
          <Button
            variant="outline"
            borderColor="studio.accent"
            color="studio.accentFg"
            disabled={!canApplyMediaMotion}
            onClick={applyMediaMotion}
          >
            <Zap size={13} /> Apply to selected media
          </Button>
          <Text fontSize="10px" color="studio.fgSubtle" lineHeight="1.5">
            Selection-scoped campaign actions are available from the project Clips view.
          </Text>
        </>
      )}

      {!studio.canPersistMotion ? (
        <Text fontSize="11px" color="studio.fgMuted" layerStyle="well" p="3">
          Motion presets are available to preview. Upgrade to save and export them.
        </Text>
      ) : null}
    </Stack>
  );
}
