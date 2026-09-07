export interface WorkflowStreamAuthorizationControl {
  error: string;
  requestId: string | null;
}

export function parseWorkflowAuthorizationControl(
  value: string,
): WorkflowStreamAuthorizationControl | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.error !== "string" || parsed.error.length > 120)
      return null;
    return {
      error: parsed.error,
      requestId:
        typeof parsed.requestId === "string" && parsed.requestId.length <= 120
          ? parsed.requestId
          : null,
    };
  } catch {
    return null;
  }
}

export function recoverFromWorkflowAuthorizationLoss(
  control: WorkflowStreamAuthorizationControl,
  currentDestination: string,
): void {
  if (control.error === "authentication_required") {
    const safeDestination =
      currentDestination.startsWith("/") && !currentDestination.startsWith("//")
        ? currentDestination
        : "/home";
    window.location.assign(
      `/sign-in?redirect_url=${encodeURIComponent(safeDestination)}`,
    );
    return;
  }
  window.location.reload();
}
