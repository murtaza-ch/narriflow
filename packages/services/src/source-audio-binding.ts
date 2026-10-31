import { sourceAudioBindingSchema } from "@narriflow/validators/execution";

/** The strict schema's declaration order is the canonical measured-binding order.
 * This hash includes measured object/duration facts; assigned artifact.bindingHash
 * instead names the frozen job/role inputs and exists before output is measured. */
export async function sourceAudioBindingHash(input: unknown): Promise<string> {
  const binding = sourceAudioBindingSchema.parse(input);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(binding)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
