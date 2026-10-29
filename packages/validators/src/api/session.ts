import { z } from "zod";
import type { PricingTier } from "../pricing";
import {
  workspaceAllowsCapability,
  type WorkspaceAccessRole,
  type WorkspaceAccessStatus,
  type WorkspaceCapability,
} from "../workspace-access";
import type { WorkspaceUsage } from "./workspace";

// Shared request schemas and response shapes of the session routes: identity
// bootstrap, Workspace selection and invitation acceptance. Everything here is
// client-safe: no Prisma enums, Dates or credentials.

/** Every Workspace capability, so a bootstrap can say which ones are currently available. */
export const WORKSPACE_CAPABILITY_NAMES = [
  "content.view",
  "content.download",
  "content.edit",
  "processing.consume",
  "publishing.manage",
  "brand.manage",
  "social.manage",
  "workspace.manage",
  "api.manage",
  "members.invite",
  "members.promote_admin",
  "billing.manage",
  "review.manage",
  "review.override",
] as const satisfies readonly WorkspaceCapability[];

type MissingCapability = Exclude<WorkspaceCapability, (typeof WORKSPACE_CAPABILITY_NAMES)[number]>;
/** Fails to compile when a capability is added to the access model but not to the list above. */
const capabilityListIsComplete: [MissingCapability] extends [never] ? true : never = true;
void capabilityListIsComplete;

export type WorkspaceCapabilities = Record<WorkspaceCapability, boolean>;

/** Which capabilities this role may use in this Workspace state (a restricted owner keeps billing). */
export function workspaceCapabilities(context: {
  role: WorkspaceAccessRole;
  status: WorkspaceAccessStatus;
}): WorkspaceCapabilities {
  return Object.fromEntries(
    WORKSPACE_CAPABILITY_NAMES.map((name) => [name, workspaceAllowsCapability(context, name)]),
  ) as WorkspaceCapabilities;
}

/** `POST /api/session/workspace-selection`. The id is checked against live membership. */
export const workspaceSelectionRequestSchema = z
  .object({ workspaceId: z.string().uuid() })
  .strict();
export type WorkspaceSelectionRequest = z.infer<typeof workspaceSelectionRequestSchema>;

/** `GET /api/session/bootstrap` query: the Workspace the browser last selected, checked against live membership. */
export const bootstrapQuerySchema = z
  .object({ workspaceId: z.string().max(128).optional() })
  .strict();

/** `/api/invites/:token` path parameter. */
export const inviteTokenParamSchema = z
  .object({ token: z.string().min(16).max(512) })
  .strict();

export interface SessionUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
}

/** A Workspace the signed-in user belongs to, with the facts needed to choose a recovery path. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  role: WorkspaceAccessRole;
  status: WorkspaceAccessStatus;
  pricingTier: PricingTier;
  isPersonal: boolean;
  /** A short-lived signed URL, or null. Never cache it past its use. */
  avatarUrl: string | null;
}

/**
 * Server-validated Clerk origins for navigating OAuth and MCP continuations.
 * They come from API configuration, never from the request.
 */
export interface AuthContinuationConfig {
  issuerUrl: string | null;
  consentOrigin: string | null;
}

/** `GET /api/session/bootstrap`: identity, memberships and the effective Workspace selection. */
export interface SessionBootstrap {
  user: SessionUser;
  memberships: WorkspaceSummary[];
  selection: {
    workspaceId: string;
    /** True when the requested Workspace was missing or removed and the personal one was chosen. */
    workspaceSelectionChanged: boolean;
  };
  /** Capabilities in the effective Workspace. A restricted Workspace still lists what its owner may do. */
  capabilities: WorkspaceCapabilities;
  /**
   * Credits of the effective Workspace, read beside the memberships so the app
   * shell needs no second request. Null when the member cannot view it (a
   * paused Workspace): the Workspace bootstrap then gives the typed refusal.
   */
  usage: WorkspaceUsage | null;
  authContinuation: AuthContinuationConfig;
}

/** `POST /api/session/workspace-selection` and `POST /api/invites/:token/accept`. */
export interface WorkspaceSelection {
  workspace: WorkspaceSummary;
  capabilities: WorkspaceCapabilities;
}

export interface InvitePreview {
  workspaceName: string;
  workspaceStatus: WorkspaceAccessStatus;
  role: WorkspaceAccessRole;
  email: string;
  expiresAt: string;
}

export interface InviteAcceptance extends WorkspaceSelection {
  /** Where the client navigates once it has adopted the selection. */
  destination: "/home";
}
