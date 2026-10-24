import { z } from "zod";
import { clipAspectRatioSchema } from "./clip";
import { socialDeliveryModeSchema, socialPlatformSchema } from "./social";

/** Publishing Queue proposals: Social Posts that wait for a person to accept
 * them into the next free slot of the account's posting schedule. */

const id = z.string().uuid();

export const SOCIAL_POST_PROPOSAL_SOURCES = ["person", "integration", "finishing"] as const;
export const socialPostProposalSourceSchema = z.enum(SOCIAL_POST_PROPOSAL_SOURCES);
export type SocialPostProposalSource = z.infer<typeof socialPostProposalSourceSchema>;

export const proposeSocialPostSchema = z.strictObject({
  clipId: id.describe("The clip to post"),
  exportId: id.describe("A finished export of that clip. Narriflow picks its variant that fits the account's platform"),
  socialAccountId: id.describe("The connected account that should post it"),
  caption: z.string().trim().max(5_000).optional().describe("The draft caption. Omit it to use the latest assisted copy for the platform, if any"),
});
export type ProposeSocialPostInput = z.infer<typeof proposeSocialPostSchema>;

/** The creator choices TikTok requires on every post, collected when a person accepts. */
export const tiktokAcceptanceSchema = z.strictObject({
  deliveryMode: socialDeliveryModeSchema,
  privacyLevel: z.string().trim().min(1).max(60).optional(),
  disableComment: z.boolean().default(false),
  disableDuet: z.boolean().default(false),
  disableStitch: z.boolean().default(false),
  isAigc: z.boolean().default(false),
});
export type TikTokAcceptanceInput = z.infer<typeof tiktokAcceptanceSchema>;

export const acceptSocialPostProposalSchema = z.strictObject({
  tiktok: tiktokAcceptanceSchema.optional().describe("Required for a TikTok proposal"),
});
export type AcceptSocialPostProposalInput = z.infer<typeof acceptSocialPostProposalSchema>;

export const updateSocialPostProposalSchema = z.strictObject({
  caption: z.string().trim().max(5_000),
});

export const socialPostProposalSchema = z.strictObject({
  proposalId: id,
  projectId: id,
  clipId: id,
  socialAccountId: id,
  platform: socialPlatformSchema,
  caption: z.string(),
  source: socialPostProposalSourceSchema,
  exportId: id,
  exportVariantId: id,
  aspectRatio: clipAspectRatioSchema,
  createdAt: z.string().datetime(),
});
export type SocialPostProposalView = z.infer<typeof socialPostProposalSchema>;
