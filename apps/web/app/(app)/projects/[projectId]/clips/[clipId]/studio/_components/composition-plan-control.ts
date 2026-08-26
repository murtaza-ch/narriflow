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

export function parseCompositionPlanControl(
  environment: WebCompositionEnvironment,
): Readonly<Record<"center" | "fit" | "auto", CompositionPlanControlMode>> {
  return Object.freeze({
    center: mode(environment, "NEXT_PUBLIC_COMPOSITION_CENTER"),
    fit: mode(environment, "NEXT_PUBLIC_COMPOSITION_FIT"),
    auto: mode(environment, "NEXT_PUBLIC_COMPOSITION_AUTO"),
  });
}

export const compositionPlanControl = parseCompositionPlanControl({
  NEXT_PUBLIC_COMPOSITION_CENTER:
    process.env.NEXT_PUBLIC_COMPOSITION_CENTER,
  NEXT_PUBLIC_COMPOSITION_FIT: process.env.NEXT_PUBLIC_COMPOSITION_FIT,
  NEXT_PUBLIC_COMPOSITION_AUTO: process.env.NEXT_PUBLIC_COMPOSITION_AUTO,
});

export function shouldAdoptCompositionPlan(mode: CompositionMode): boolean {
  if (mode !== "center" && mode !== "fit" && mode !== "auto") return false;
  return compositionPlanControl[mode] === "plan";
}
