export type CompositionPlanQaFixture = "invalid";

type InvalidCompositionPlanResult = {
  readonly status: "invalid";
  readonly error: { readonly code: "invalid_target" };
};

export function resolveCompositionPlanQaFixture(
  value: string | string[] | undefined,
  environment: string | undefined,
): CompositionPlanQaFixture | null {
  if (environment === "production") return null;
  return value === "invalid" ? "invalid" : null;
}

export function applyCompositionPlanQaFixture<T>(
  result: T,
  fixture: CompositionPlanQaFixture | null,
): T | InvalidCompositionPlanResult {
  if (fixture !== "invalid") return result;
  return {
    status: "invalid",
    error: { code: "invalid_target" },
  };
}
