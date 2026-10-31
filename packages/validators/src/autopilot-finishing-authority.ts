import { z } from "zod";
import { FINISHING_MAX_QUEUE_ACCOUNTS } from "./finishing";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const frozenStandingGrantSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  ruleFingerprint: fingerprint,
});
export type FrozenStandingGrant = z.infer<typeof frozenStandingGrantSchema>;

/** Authority observed when the source was admitted. Null grants stay null on retries. */
export const autopilotFinishingAuthoritySchema = z.strictObject({
  sourceRuleFingerprint: fingerprint,
  publish: z.array(z.strictObject({
    socialAccountId: z.string().uuid(),
    grant: frozenStandingGrantSchema.nullable(),
  })).max(FINISHING_MAX_QUEUE_ACCOUNTS),
  review: frozenStandingGrantSchema.nullable(),
}).superRefine((value, context) => {
  if (new Set(value.publish.map(item => item.socialAccountId)).size !== value.publish.length)
    context.addIssue({ code: "custom", path: ["publish"], message: "Each destination occurs once" });
  for (const grant of [...value.publish.map(item => item.grant), value.review]) {
    if (grant && grant.ruleFingerprint !== value.sourceRuleFingerprint)
      context.addIssue({ code: "custom", message: "A grant must cover the accepted source settings" });
  }
});
export type AutopilotFinishingAuthority = z.infer<typeof autopilotFinishingAuthoritySchema>;
