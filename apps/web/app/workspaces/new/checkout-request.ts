import type { BillingInterval } from "@narriflow/validators";

export interface PreservedWorkspaceCheckoutState {
  workspaceId?: string;
  workspaceName?: string;
  interval?: BillingInterval;
  checkoutIdempotencyKey?: string;
}

export function buildBusinessWorkspaceCheckoutRequest(
  previous: PreservedWorkspaceCheckoutState,
  formData: FormData,
): Readonly<Record<string, unknown>> {
  const submitted = Object.fromEntries(formData.entries());
  return {
    ...submitted,
    ...(submitted.name === undefined && previous.workspaceName
      ? { name: previous.workspaceName }
      : {}),
    ...(submitted.interval === undefined && previous.interval
      ? { interval: previous.interval }
      : {}),
    ...(previous.workspaceId ? { workspaceId: previous.workspaceId } : {}),
    ...(previous.checkoutIdempotencyKey
      ? { checkoutIdempotencyKey: previous.checkoutIdempotencyKey }
      : {}),
  };
}

export function recoverBusinessWorkspaceCheckoutFields(
  previous: PreservedWorkspaceCheckoutState,
  request: Readonly<Record<string, unknown>>,
): Pick<PreservedWorkspaceCheckoutState, "workspaceName" | "interval"> {
  const submittedName = request.name;
  const workspaceName =
    typeof submittedName === "string"
      ? submittedName
          .normalize("NFKC")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80)
      : previous.workspaceName;
  const submittedInterval = request.interval;
  const interval =
    submittedInterval === "monthly" || submittedInterval === "annual"
      ? submittedInterval
      : previous.interval;
  return {
    ...(workspaceName !== undefined ? { workspaceName } : {}),
    ...(interval ? { interval } : {}),
  };
}
