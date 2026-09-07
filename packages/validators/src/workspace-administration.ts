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

export const workspaceInviteActionSchema = z
  .object({
    email: z.string().trim().email().max(320),
    role: z.enum(["admin", "editor", "viewer"]),
  })
  .strict();

export const workspaceApiKeyScopeSchema = z.enum([
  "projects:read",
  "exports:read",
  "usage:read",
  "autopilot:read",
  "autopilot:write",
]);

export const workspaceApiKeyActionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(workspaceApiKeyScopeSchema).min(1).max(5).optional(),
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

export const onboardingProfileActionSchema = z
  .object({
    firstName: z.string().trim().max(100),
    lastName: z.string().trim().max(100),
  })
  .strict();

const workspaceEntityIdSchema = z.string().min(1).max(128);

export const workspaceInviteReferenceActionSchema = z
  .object({ inviteId: workspaceEntityIdSchema })
  .strict();

export const workspaceMemberRoleActionSchema = z
  .object({
    memberId: workspaceEntityIdSchema,
    role: z.enum(["admin", "editor", "viewer"]),
  })
  .strict();

export const workspaceMemberReferenceActionSchema = z
  .object({ memberId: workspaceEntityIdSchema })
  .strict();

export const workspaceApiKeyReferenceActionSchema = z
  .object({ keyId: workspaceEntityIdSchema })
  .strict();

export const workspaceInviteAcceptanceActionSchema = z
  .object({ token: z.string().min(16).max(512) })
  .strict();

export const workspaceSelectionActionSchema = z
  .object({ workspaceId: workspaceEntityIdSchema })
  .strict();

export type WorkspaceSettingsActionInput = z.infer<
  typeof workspaceSettingsActionSchema
>;
export type WorkspaceInviteActionInput = z.infer<
  typeof workspaceInviteActionSchema
>;
export type WorkspaceApiKeyActionInput = z.infer<
  typeof workspaceApiKeyActionSchema
>;
