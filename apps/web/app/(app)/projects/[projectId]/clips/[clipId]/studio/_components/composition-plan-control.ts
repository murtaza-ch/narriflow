import type { CompositionMode } from "@narriflow/composition-plan";

export type CompositionPlanControlMode = "legacy" | "shadow" | "plan";

type WebCompositionEnvironment = Record<string, string | undefined>;

function mode(
  environment: WebCompositionEnvironment,
  name: string,
): CompositionPlanControlMode {
  const value = environment[name]?.trim() || "shadow";
  if (value === "legacy" || value === "shadow" || value === "plan") {
    return value;
  }
  throw new Error(`${name} must be one of legacy, shadow, plan`);
}

function enabled(environment: WebCompositionEnvironment, name: string): boolean {
  const value = environment[name]?.trim() || "1";
  if (value !== "0" && value !== "1") {
    throw new Error(`${name} must be 0 or 1`);
  }
  return value === "1";
}

export function parseCompositionPlanControl(
  environment: WebCompositionEnvironment,
): Readonly<
  Record<"center" | "fit" | "auto", CompositionPlanControlMode> & {
    automaticSpeakerLayoutEnabled: boolean;
    explicitSplitLayoutEnabled: boolean;
    screenLayoutEnabled: boolean;
  } & Record<"split" | "screen", CompositionPlanControlMode>
> {
  return Object.freeze({
    center: mode(environment, "NEXT_PUBLIC_COMPOSITION_CENTER"),
    fit: mode(environment, "NEXT_PUBLIC_COMPOSITION_FIT"),
    auto: mode(environment, "NEXT_PUBLIC_COMPOSITION_AUTO"),
    split: mode(environment, "NEXT_PUBLIC_COMPOSITION_SPLIT"),
    screen: mode(environment, "NEXT_PUBLIC_COMPOSITION_SCREEN"),
    automaticSpeakerLayoutEnabled: enabled(
      environment,
      "NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT",
    ),
    explicitSplitLayoutEnabled: enabled(
      environment,
      "NEXT_PUBLIC_SPLIT_LAYOUT",
    ),
    screenLayoutEnabled: enabled(environment, "NEXT_PUBLIC_SCREEN_LAYOUT"),
  });
}

export const compositionPlanControl = parseCompositionPlanControl({
  NEXT_PUBLIC_COMPOSITION_CENTER:
    process.env.NEXT_PUBLIC_COMPOSITION_CENTER,
  NEXT_PUBLIC_COMPOSITION_FIT: process.env.NEXT_PUBLIC_COMPOSITION_FIT,
  NEXT_PUBLIC_COMPOSITION_AUTO: process.env.NEXT_PUBLIC_COMPOSITION_AUTO,
  NEXT_PUBLIC_COMPOSITION_SPLIT: process.env.NEXT_PUBLIC_COMPOSITION_SPLIT,
  NEXT_PUBLIC_COMPOSITION_SCREEN: process.env.NEXT_PUBLIC_COMPOSITION_SCREEN,
  NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT:
    process.env.NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT,
  NEXT_PUBLIC_SPLIT_LAYOUT: process.env.NEXT_PUBLIC_SPLIT_LAYOUT,
  NEXT_PUBLIC_SCREEN_LAYOUT: process.env.NEXT_PUBLIC_SCREEN_LAYOUT,
});

export function shouldAdoptCompositionPlan(mode: CompositionMode): boolean {
  return compositionPlanControl[mode] === "plan";
}
