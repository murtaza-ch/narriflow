import { hasUserErrorMessage, userErrorMessage } from "@narriflow/validators";
import type { UpgradePrompt } from "@/app/(app)/_components/upgrade";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
import type { StudioSessionSnapshot } from "./studio-editing-session";

/**
 * Why autosave is stopped, in the terms the save-status popover speaks. Every
 * cause keeps the local edits; the popover only offers ways to continue.
 */
export type SaveIssue =
  /** The plan doesn't include something in the edit; a higher plan does. */
  | { kind: "plan"; message: string; prompt: UpgradePrompt }
  /** B-roll placements whose image was deleted. */
  | { kind: "deleted-broll"; placementIds: readonly string[] }
  /** The server refused the document for a reason editing can undo. */
  | { kind: "rejected"; message: string }
  | { kind: "signed-out" }
  | { kind: "missing" }
  /** Someone saved a newer version. `resolvable` once both versions are loaded. */
  | { kind: "conflict"; resolvable: boolean };

export const DELETED_BROLL_CODE = "visual_broll_asset_invalid";

function placementIds(details: Record<string, unknown> | null): string[] {
  const ids = details?.placementIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}

export function saveIssueFor(
  cloud: StudioSessionSnapshot["cloud"],
  status: StudioSessionSnapshot["status"],
): SaveIssue | null {
  switch (cloud.state) {
    case "authentication-lost":
      return { kind: "signed-out" };
    case "missing":
      return { kind: "missing" };
    case "revision-conflict":
      return { kind: "conflict", resolvable: status === "conflict" };
    case "rejected": {
      const code = cloud.rejectionCode ?? "";
      const details = cloud.rejection?.details ?? null;
      if (code === DELETED_BROLL_CODE) {
        const ids = placementIds(details);
        if (ids.length > 0) return { kind: "deleted-broll", placementIds: ids };
      }
      const message = cloud.rejection?.message ?? null;
      const prompt = upgradePromptFromFailure({
        error: code,
        ...(message ? { message } : {}),
        ...(details ? { details } : {}),
      });
      if (prompt) {
        return {
          kind: "plan",
          message: message ?? userErrorMessage(code) ?? "Your plan doesn't include this.",
          prompt,
        };
      }
      return {
        kind: "rejected",
        message: hasUserErrorMessage(code)
          ? (userErrorMessage(code) as string)
          : "This change can't be saved.",
      };
    }
    default:
      return null;
  }
}
