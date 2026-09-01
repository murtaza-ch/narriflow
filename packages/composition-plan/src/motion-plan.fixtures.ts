import { CLIP_TRANSITION_TYPES } from "@narriflow/validators";
import type { MediaMotion, SceneMotion } from "@narriflow/validators";

export const MOTION_TARGET_FIXTURES = [
  { id: "vertical", width: 1080, height: 1920 },
  { id: "square", width: 1080, height: 1080 },
  { id: "landscape", width: 1920, height: 1080 },
] as const;

const entrances: readonly SceneMotion["entrance"][] = [
  "none",
  "fade",
  "scale-in",
  "pan-left",
  "pan-right",
  "pan-up",
  "pan-down",
  "ken-burns-in",
];

const exits: readonly SceneMotion["exit"][] = [
  "none",
  "fade",
  "scale-out",
  "pan-left",
  "pan-right",
  "pan-up",
  "pan-down",
  "ken-burns-out",
];

/** Shared deterministic cases consumed by planner, browser, and FFmpeg tests. */
export const MOTION_ADAPTER_FIXTURES = {
  transitions: CLIP_TRANSITION_TYPES.map((type, index) => ({
    id: `transition:${type}`,
    type,
    durationSec: 0.4,
    activeRange: index % 2 === 0
      ? { startSec: 0, endSec: 0.3 }
      : { startSec: 0, endSec: 3 },
    target: MOTION_TARGET_FIXTURES[index % MOTION_TARGET_FIXTURES.length]!,
  })),
  media: [
    ...entrances.map((entrance, index) => ({
      id: `entrance:${entrance}`,
      entrance,
      exit: "none" as const,
      durationSec: 0.5,
      activeRange: index === 0 ? { startSec: 1, endSec: 1.2 } : { startSec: 1, endSec: 4 },
      targetKind: index % 2 === 0 ? "broll" as const : "scene_block" as const,
      target: MOTION_TARGET_FIXTURES[index % MOTION_TARGET_FIXTURES.length]!,
    })),
    ...exits.map((exit, index) => ({
      id: `exit:${exit}`,
      entrance: "none" as const,
      exit,
      durationSec: 0.5,
      activeRange: index === 0 ? { startSec: 2, endSec: 2.2 } : { startSec: 2, endSec: 5 },
      targetKind: index % 2 === 0 ? "scene_block" as const : "broll" as const,
      target: MOTION_TARGET_FIXTURES[index % MOTION_TARGET_FIXTURES.length]!,
    })),
  ] satisfies ReadonlyArray<{
    id: string;
    entrance: MediaMotion["entrance"];
    exit: MediaMotion["exit"];
    durationSec: number;
    activeRange: { startSec: number; endSec: number };
    targetKind: "broll" | "scene_block";
    target: { id: string; width: number; height: number };
  }>,
} as const;
