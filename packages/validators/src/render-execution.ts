import { z } from "zod";

/** A failed variant has a sealed outcome instead of fabricated media bytes. */
export const renderVariantFailureSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("failed"), renderId: z.string().uuid(),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  errorCode: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
  disposition: z.enum(["retryable", "permanent"]),
});
export type RenderVariantFailure = z.infer<typeof renderVariantFailureSchema>;
