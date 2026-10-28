import { z } from "zod";
import { workspaceCensorWordsSchema } from "../censor-words";
import type { PricingTier } from "../pricing";
import type { WorkspaceAccessRole } from "../workspace-access";
import {
  performanceGuidanceSettingActionSchema,
  workspaceInviteActionSchema,
  workspaceSettingsActionSchema,
} from "../workspace-administration";
import type { WorkspaceCapabilities, WorkspaceSummary, SessionUser } from "./session";

// Shared request schemas and response shapes of the Workspace routes.

/** `PATCH /api/workspace`. */
export const updateWorkspaceRequestSchema = workspaceSettingsActionSchema;
/** `PATCH /api/workspace/performance-guidance`. */
export const performanceGuidanceRequestSchema = performanceGuidanceSettingActionSchema;
/** `POST /api/workspace/invites`. */
export const inviteMemberRequestSchema = workspaceInviteActionSchema;

/** `PATCH /api/workspace/members/:memberId`. The owner role is never assignable. */
export const changeMemberRoleRequestSchema = z
  .object({ role: z.enum(["admin", "editor", "viewer"]) })
  .strict();

/** `PUT /api/workspace/censor-words`: the whole list replaces the previous one. */
export const replaceCensorWordsRequestSchema = z
  .object({ words: workspaceCensorWordsSchema })
  .strict();

/** `POST /api/workspace/avatar/presign`. Type and size are checked by the service. */
export const presignAvatarRequestSchema = z
  .object({ contentType: z.string().max(100), sizeBytes: z.number() })
  .strict();

/** `PATCH /api/workspace/avatar`. `null` removes the avatar. */
export const setAvatarRequestSchema = z
  .object({ storageKey: z.string().max(512).nullable() })
  .strict();

export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;
export type InviteMemberRequest = z.infer<typeof inviteMemberRequestSchema>;
export type ChangeMemberRoleRequest = z.infer<typeof changeMemberRoleRequestSchema>;
export type ReplaceCensorWordsRequest = z.infer<typeof replaceCensorWordsRequestSchema>;

/** Credits for the current UTC month. Dates are ISO strings. */
export interface WorkspaceUsage {
  tier: PricingTier;
  usedCredits: number;
  reservedCredits: number;
  limitCredits: number;
  remainingCredits: number;
  periodStart: string;
  renewsAt: string;
  inFlight: number;
  inFlightLimit: number;
  maxUploadSeconds: number;
}

/** `GET /api/workspace/bootstrap`: what the app shell needs, read in parallel. */
export interface WorkspaceBootstrap {
  user: SessionUser;
  workspace: WorkspaceSummary;
  memberships: WorkspaceSummary[];
  capabilities: WorkspaceCapabilities;
  usage: WorkspaceUsage;
}

/** `GET /api/workspace`. */
export interface WorkspaceProfile extends WorkspaceSummary {
  timezone: string;
  createdAt: string;
  billingInterval: "monthly" | "annual" | null;
  currentPeriodEndAt: string | null;
}

export interface WorkspaceMemberView {
  id: string;
  role: WorkspaceAccessRole;
  joinedAt: string;
  user: {
    id: string;
    primaryEmail: string | null;
    firstName: string | null;
    lastName: string | null;
    imageUrl: string | null;
  };
}

export interface WorkspaceInviteView {
  id: string;
  email: string;
  role: WorkspaceAccessRole;
  expiresAt: string;
  createdAt: string;
}

/** `GET /api/workspace/members`. */
export interface WorkspaceMembers {
  members: WorkspaceMemberView[];
  invites: WorkspaceInviteView[];
}

/**
 * `POST /api/workspace/invites` and `/:inviteId/resend`. The link and delivery
 * result are known only to the request that created the invite; a replay of a
 * lost response carries `null` for both, and the admin uses Resend.
 */
export interface InviteIssued {
  invite: Pick<WorkspaceInviteView, "id" | "email" | "role" | "expiresAt">;
  inviteUrl: string | null;
  emailSent: boolean | null;
  replayed: boolean;
}
