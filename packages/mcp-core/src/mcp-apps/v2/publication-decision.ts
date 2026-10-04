export function createPublicationDecision() {
  let state: "prepared" | "pending" | "uncertain" | "scheduled" | "declined" = "prepared";
  return {
    get state() { return state; },
    get canConfirm() { return state === "prepared" || state === "uncertain"; },
    get canDecline() { return state === "prepared"; },
    async decide(accepted: boolean, operation: (markSchedulingAttempted: () => void) => Promise<void>) {
      if (state !== "prepared" && !(accepted && state === "uncertain")) return;
      let schedulingAttempted = state === "uncertain";
      state = "pending";
      try {
        await operation(() => { schedulingAttempted = true; });
        state = accepted ? "scheduled" : "declined";
      } catch (error) {
        state = schedulingAttempted ? "uncertain" : "prepared";
        throw error;
      }
    },
  };
}

export function isPublicationDeclined(result: { isError?: boolean; structuredContent?: unknown }) {
  if (!result.isError || !result.structuredContent || typeof result.structuredContent !== "object") return false;
  const data = (result.structuredContent as { data?: unknown }).data;
  return Boolean(data && typeof data === "object" && (data as { error?: unknown }).error === "mcp_confirmation_declined");
}
