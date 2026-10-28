import {
  CALENDAR_WINDOW_PADDING_MS,
  type PerformanceEmptyNextStep,
} from "@narriflow/validators/api/publishing";
import {
  performanceSyncAvailable,
  workspaceAllowsCapability,
  type SocialAccountSnapshot,
  type WorkspaceAccessRole,
  type WorkspaceAccessStatus,
} from "@narriflow/validators";

type Actor = { role: WorkspaceAccessRole; status: WorkspaceAccessStatus };

/** The calendar's view window widened so a post near an edge appears in every Workspace time zone. */
export function paddedCalendarWindow(window: { from: Date; to: Date }) {
  return {
    from: new Date(window.from.getTime() - CALENDAR_WINDOW_PADDING_MS),
    to: new Date(window.to.getTime() + CALENDAR_WINDOW_PADDING_MS),
  };
}

/**
 * What the empty Performance page offers next. Measuring needs a post from a
 * connected YouTube or TikTok account; who can act on it follows the
 * capabilities (publish, else connect, else ask someone who can).
 */
export function performanceEmptyNextStep(
  actor: Actor,
  accounts: ReadonlyArray<Pick<SocialAccountSnapshot, "publishingEligible" | "platform">>,
): PerformanceEmptyNextStep {
  if (!workspaceAllowsCapability(actor, "publishing.manage")) return null;
  const measurable = accounts.some(
    (account) => account.publishingEligible && performanceSyncAvailable(account.platform),
  );
  if (measurable) return "publish";
  return workspaceAllowsCapability(actor, "social.manage") ? "connect" : "ask";
}
