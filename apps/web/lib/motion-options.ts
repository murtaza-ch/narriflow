import type { SceneMotion, StudioTransition } from "@narriflow/validators";

export const TRANSITION_OPTIONS: ReadonlyArray<{
  value: StudioTransition["type"];
  label: string;
  shortLabel: string;
  family: "cut" | "fade" | "wipe" | "slide" | "zoom";
}> = [
  { value: "none", label: "Cut", shortLabel: "Cut", family: "cut" },
  { value: "fade", label: "Fade", shortLabel: "Fade", family: "fade" },
  { value: "fade-black", label: "Fade to black", shortLabel: "Fade black", family: "fade" },
  { value: "dip-white", label: "Dip white", shortLabel: "Dip white", family: "fade" },
  { value: "wipe-left", label: "Wipe left", shortLabel: "Wipe left", family: "wipe" },
  { value: "wipe-right", label: "Wipe right", shortLabel: "Wipe right", family: "wipe" },
  { value: "wipe-up", label: "Wipe up", shortLabel: "Wipe up", family: "wipe" },
  { value: "wipe-down", label: "Wipe down", shortLabel: "Wipe down", family: "wipe" },
  { value: "slide-left", label: "Slide left", shortLabel: "Slide left", family: "slide" },
  { value: "slide-right", label: "Slide right", shortLabel: "Slide right", family: "slide" },
  { value: "slide-up", label: "Slide up", shortLabel: "Slide up", family: "slide" },
  { value: "slide-down", label: "Slide down", shortLabel: "Slide down", family: "slide" },
  { value: "zoom-in", label: "Zoom in", shortLabel: "Zoom in", family: "zoom" },
  { value: "zoom-out", label: "Zoom out", shortLabel: "Zoom out", family: "zoom" },
];

export const MOTION_ENTRANCE_OPTIONS: ReadonlyArray<{
  value: SceneMotion["entrance"];
  label: string;
}> = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade in" },
  { value: "scale-in", label: "Scale in" },
  { value: "pan-left", label: "Pan left" },
  { value: "pan-right", label: "Pan right" },
  { value: "pan-up", label: "Pan up" },
  { value: "pan-down", label: "Pan down" },
  { value: "ken-burns-in", label: "Ken Burns in" },
];

export const MOTION_EXIT_OPTIONS: ReadonlyArray<{
  value: SceneMotion["exit"];
  label: string;
}> = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade out" },
  { value: "scale-out", label: "Scale out" },
  { value: "pan-left", label: "Pan left" },
  { value: "pan-right", label: "Pan right" },
  { value: "pan-up", label: "Pan up" },
  { value: "pan-down", label: "Pan down" },
  { value: "ken-burns-out", label: "Ken Burns out" },
];
