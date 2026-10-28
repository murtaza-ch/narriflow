import { describeApiFailure } from "@narriflow/api-client/core";
import type { LinkResumeData, LinkResumeResult } from "@narriflow/validators/api/ingest";

/** What the upload page does with `?project=<id>` once the resume read answers. */
export type ResumeDecision =
  | { kind: "pending" }
  /** No project in the link: a fresh import. */
  | { kind: "fresh" }
  | { kind: "resume"; data: LinkResumeData }
  /** Configure already finished; the Project page is where this import lives now. */
  | { kind: "open_project"; projectId: string }
  /** Nothing to resume (missing, not a link import, no draft): start over at `/upload`. */
  | { kind: "restart" }
  /** The Project belongs to another Workspace; switching is the person's choice, never automatic. */
  | { kind: "workspace_mismatch" }
  | { kind: "failed"; error: unknown };

export function decideResume(projectId: string, result: LinkResumeResult): ResumeDecision {
  switch (result.outcome) {
    case "resume":
      return { kind: "resume", data: result.data };
    case "open_project":
      return { kind: "open_project", projectId };
    case "restart":
      return { kind: "restart" };
  }
}

/**
 * A concealed or malformed Project is the same as one with nothing to resume. Any other
 * failure (network, server) is shown, so a person is not silently dropped from a saved draft.
 */
export function decideResumeFailure(error: unknown): ResumeDecision {
  const failure = describeApiFailure(error);
  if (failure.kind === "missing" || failure.kind === "validation") return { kind: "restart" };
  if (failure.kind === "workspace_mismatch") return { kind: "workspace_mismatch" };
  return { kind: "failed", error };
}
