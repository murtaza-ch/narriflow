import type { verifyMcpUploadHandoff } from "@narriflow/mcp-core";
import { ExpectedDomainFailureError } from "@narriflow/services";

/** Signature, actor, workspace and current access must be verified by the
 * caller. Expiry permits continuing only an existing owned Upload Session. */
export async function requireMcpUploadHandoffAdmission(
  state: ReturnType<typeof verifyMcpUploadHandoff>,
  hasAcceptedUpload: () => Promise<boolean>,
  now = Date.now(),
) {
  if (now < state.expiresAtMs || await hasAcceptedUpload()) return;
  throw new ExpectedDomainFailureError({ code: "mcp_upload_handoff_expired", kind: "conflict", message: "The upload handoff expired. Open the upload tool again to continue." });
}
