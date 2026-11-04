import { z } from "zod";

export const workspaceSettingsActionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((timezone) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(
            new Date(0),
          );
          return true;
        } catch {
          return false;
        }
      }, "Enter a valid IANA timezone, such as America/New_York"),
  })
  .strict();

/** "Use my performance data to pick clips". */
export const performanceGuidanceSettingActionSchema = z
  .object({ enabled: z.boolean() })
  .strict();

export const workspaceInviteActionSchema = z
  .object({
    email: z.string().trim().email().max(320),
    role: z.enum(["admin", "editor", "viewer"]),
  })
  .strict();

export const WORKSPACE_API_KEY_SCOPES = [
  "projects:read",
  "exports:read",
  "processing:write",
  "exports:write",
  "usage:read",
  "autopilot:read",
  "autopilot:write",
  "publishing:read",
  "publishing:write",
] as const;

export type WorkspaceApiKeyScope = (typeof WORKSPACE_API_KEY_SCOPES)[number];

export const WORKSPACE_API_KEY_READ_SCOPES = [
  "projects:read",
  "exports:read",
  "usage:read",
  "autopilot:read",
  "publishing:read",
] as const satisfies readonly WorkspaceApiKeyScope[];

export const workspaceApiKeyScopeSchema = z.enum(WORKSPACE_API_KEY_SCOPES);

export const workspaceApiKeyActionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(workspaceApiKeyScopeSchema).min(1).max(WORKSPACE_API_KEY_SCOPES.length).optional(),
  })
  .strict();

const businessWorkspaceCheckoutBase = {
  interval: z.enum(["monthly", "annual"]),
  checkoutIdempotencyKey: z.string().uuid().optional(),
};

export const businessWorkspaceCheckoutActionSchema = z.union([
  z
    .object({
      ...businessWorkspaceCheckoutBase,
      name: z.string().trim().min(1).max(80),
      workspaceId: z.undefined().optional(),
    })
    .strict(),
  z
    .object({
      ...businessWorkspaceCheckoutBase,
      name: z.string().trim().min(1).max(80).optional(),
      workspaceId: z.string().min(1).max(128),
    })
    .strict(),
]);
