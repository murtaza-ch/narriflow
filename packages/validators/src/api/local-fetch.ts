import { z } from "zod";

export const localFetchDeviceClaimsSchema = z.strictObject({
  version: z.literal(1), keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), sessionId: z.string().uuid(),
  workspaceId: z.string().uuid(), actorUserId: z.string().uuid(), deploymentEpoch: z.number().int().positive(),
  apiOrigin: z.string().url(), issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
});
export type LocalFetchDeviceClaims = z.infer<typeof localFetchDeviceClaimsSchema>;
export const localFetchWorkspaceIdsSchema = z.array(z.uuid()).max(20);
export const localFetchDeviceConfigurationSchema = z.strictObject({
  version: z.literal(1), apiOrigin: z.string().url(), sessionToken: z.string().min(1).max(2048),
  keyId: z.string().uuid(), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/), workspaceId: z.string().uuid(), expiresAt: z.number().int().positive(),
  toolchainFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type LocalFetchDeviceConfiguration = z.infer<typeof localFetchDeviceConfigurationSchema>;
