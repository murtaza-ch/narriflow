import { z } from "zod";
import { socialPlatformSchema } from "./social";
import { standingGrantKindSchema, standingGrantPauseReasonSchema } from "./standing-grant";

/** Workspace Events: the public, versioned contract of the `/api/v1/events`
 * feed and the `narriflow_list_events` tool. A subject carries IDs only. */

const id = z.string().uuid();

export const WORKSPACE_EVENT_TYPES = ["autopilot.episode_imported", "operation.finished", "finishing.finished", "social_post.proposed", "social_post.finished", "grant.paused", "grant.expired"] as const;
export const workspaceEventTypeSchema = z.enum(WORKSPACE_EVENT_TYPES);
export type WorkspaceEventType = z.infer<typeof workspaceEventTypeSchema>;

/** `asc` reads forward from a cursor; `desc` reads the newest matching events, newest first, and has no cursor. */
export const WORKSPACE_EVENT_ORDERS = ["asc", "desc"] as const;
export const workspaceEventOrderSchema = z.enum(WORKSPACE_EVENT_ORDERS);
export type WorkspaceEventOrder = z.infer<typeof workspaceEventOrderSchema>;

/** Rows older than this are deleted; a poller that is down longer re-syncs from list endpoints. */
export const WORKSPACE_EVENT_RETENTION_DAYS = 30;
export const WORKSPACE_EVENT_DEFAULT_LIMIT = 100;
export const WORKSPACE_EVENT_MAX_LIMIT = 200;

/** The types that expose publishing need a second scope. */
export const WORKSPACE_EVENT_PUBLISHING_TYPES: readonly WorkspaceEventType[] = ["social_post.proposed", "social_post.finished"];

export const autopilotEpisodeImportedSubjectSchema = z.strictObject({
  ruleId: id,
  projectId: id,
  episodeId: z.string().describe("The feed's identifier for the episode"),
});

export const operationFinishedSubjectSchema = z.strictObject({
  operation: z.strictObject({
    kind: z.enum(["intake", "generation", "export"]),
    id: z.string().describe("The operationId that GET /operations/{id} accepts"),
  }),
  projectId: id.nullable().describe("Null when an upload ended before its import created a project"),
  state: z.enum(["completed", "partial", "failed", "cancelled"]),
});

export const finishingFinishedSubjectSchema = z.strictObject({
  projectId: id,
  operation: z.strictObject({ kind: z.literal("generation"), id: z.string().describe("The generation's operationId") }),
  state: z.enum(["ready", "partial", "skipped"]),
  reason: z.string().nullable().describe("Why finishing was skipped or incomplete; null when ready"),
  exportIds: z.array(id).describe("The exports that finished, one or more per picked clip"),
});

export const socialPostProposedSubjectSchema = z.strictObject({
  socialPostId: id.describe("The proposal's ID"),
  projectId: id,
  clipId: id,
  socialAccountId: id,
  platform: socialPlatformSchema,
});

export const socialPostFinishedSubjectSchema = z.strictObject({
  socialPostId: id,
  projectId: id,
  clipId: id.nullable(),
  platform: socialPlatformSchema,
  state: z.enum(["posted", "sent_to_inbox", "failed", "needs_attention"]),
});

export const grantPausedSubjectSchema = z.strictObject({
  grantId: id,
  kind: standingGrantKindSchema,
  autopilotRuleId: id.nullable().describe("Null if the rule was deleted"),
  reason: standingGrantPauseReasonSchema,
});

export const grantExpiredSubjectSchema = z.strictObject({
  grantId: id,
  kind: standingGrantKindSchema,
  autopilotRuleId: id.nullable().describe("Null if the rule was deleted"),
});

export type WorkspaceEventSubjects = {
  "autopilot.episode_imported": z.infer<typeof autopilotEpisodeImportedSubjectSchema>;
  "operation.finished": z.infer<typeof operationFinishedSubjectSchema>;
  "finishing.finished": z.infer<typeof finishingFinishedSubjectSchema>;
  "social_post.proposed": z.infer<typeof socialPostProposedSubjectSchema>;
  "social_post.finished": z.infer<typeof socialPostFinishedSubjectSchema>;
  "grant.paused": z.infer<typeof grantPausedSubjectSchema>;
  "grant.expired": z.infer<typeof grantExpiredSubjectSchema>;
};

const envelope = {
  id: id.describe("Deduplicate by this ID: delivery is at least once"),
  seq: z.number().int().positive().describe("Orders events within a Workspace; pass the last one as the next cursor"),
  version: z.literal(1),
  occurredAt: z.string().datetime(),
};

export const workspaceEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("autopilot.episode_imported"), subject: autopilotEpisodeImportedSubjectSchema }),
  z.strictObject({ ...envelope, type: z.literal("operation.finished"), subject: operationFinishedSubjectSchema }),
  z.strictObject({ ...envelope, type: z.literal("finishing.finished"), subject: finishingFinishedSubjectSchema }),
  z.strictObject({ ...envelope, type: z.literal("social_post.proposed"), subject: socialPostProposedSubjectSchema }),
  z.strictObject({ ...envelope, type: z.literal("social_post.finished"), subject: socialPostFinishedSubjectSchema }),
  z.strictObject({ ...envelope, type: z.literal("grant.paused"), subject: grantPausedSubjectSchema }),
  z.strictObject({ ...envelope, type: z.literal("grant.expired"), subject: grantExpiredSubjectSchema }),
]);
export type WorkspaceEventView = z.infer<typeof workspaceEventSchema>;

/** `after` is a previous `nextCursor`; omit it to start at the oldest retained event. */
export const workspaceEventCursorSchema = z.string().regex(/^\d{1,15}$/).describe("A previous nextCursor; omit to start at the oldest retained event");

/** REST returns this body; the MCP tool returns it as its result data. */
export const workspaceEventsResultSchema = z.strictObject({
  data: z.array(workspaceEventSchema),
  nextCursor: z.string().describe("Pass as `after` on the next poll; the input cursor when no event is newer"),
});

/** Splits REST's comma-separated `types`; null names an unknown type. */
export function parseWorkspaceEventTypes(value: string | undefined): WorkspaceEventType[] | null {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const types = entries.flatMap((entry) => {
    const parsed = workspaceEventTypeSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  return types.length === entries.length ? types : null;
}
