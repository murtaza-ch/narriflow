import { z } from "zod";

/** A failed variant has a sealed outcome instead of fabricated media bytes. */
export const renderVariantFailureSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("failed"), renderId: z.string().uuid(),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  errorCode: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
  disposition: z.enum(["retryable", "permanent"]),
});
export type RenderVariantFailure = z.infer<typeof renderVariantFailureSchema>;

/** Authoritative settlement facts from the transaction publishing the final member. */
export const renderGroupOutcomeSchema = z.strictObject({
  status: z.enum(["queued", "completed", "partial", "failed", "superseded"]),
  requested: z.number().int().positive().max(4),
  succeeded: z.number().int().nonnegative().max(4),
  failed: z.number().int().nonnegative().max(4),
  superseded: z.number().int().nonnegative().max(4),
}).refine(value => {
  const settled = value.succeeded + value.failed + value.superseded;
  if (value.status === "queued") return settled < value.requested;
  if (settled !== value.requested) return false;
  if (value.status === "superseded") return value.superseded === value.requested;
  if (value.status === "completed") return value.succeeded > 0 && value.failed === 0;
  if (value.status === "partial") return value.succeeded > 0 && value.failed > 0;
  return value.failed > 0 && value.succeeded === 0;
}, "Outcome counts must cover exactly the settled group members");
export type RenderGroupOutcome = z.infer<typeof renderGroupOutcomeSchema>;
