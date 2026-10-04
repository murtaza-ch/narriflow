"use server";

import { redirect } from "next/navigation";
import { acceptMcpConfirmation, verifyMcpPreparation } from "@narriflow/mcp-core";
import { hasFeature, socialPublicationScheduling, workspaceService } from "@narriflow/services";
import { getMcpMutationGuard } from "@/lib/mcp-auth";
import { executeSignedInAction } from "@/lib/authenticated-request-action";
import { admitMcpContinuation } from "@/lib/mcp-continuation-principal";

export async function confirmMcpPublication(form: FormData) {
  const token = String(form.get("token") ?? "");
  // The signed continuation selects the workspace. Identity admission must not
  // borrow the browser's unrelated active workspace before verifying that state.
  const result = await executeSignedInAction(async (actorUser) => {
    const prepared = verifyMcpPreparation(token, { actorUserId: actorUser.actorUserId });
    const actor = await workspaceService.requireActor(actorUser.actorUserId, prepared.workspaceId, "publishing.manage");
    if (actor.status !== "active" || !hasFeature(actor.pricingTier, "integrations.mcp")) return { destination: "/integrations/mcp" };
    if (form.get("decision") !== "confirm") return { destination: "/integrations/mcp/confirm?declined=1" };
    acceptMcpConfirmation(token, { actorUserId: actorUser.actorUserId, accepted: true });
    const guard = await getMcpMutationGuard(await admitMcpContinuation(prepared, "publishing:write"));
    const publication = await socialPublicationScheduling.schedule({ ...prepared.intent, actorUserId: actorUser.actorUserId, scheduledFor: new Date(prepared.intent.scheduledFor), beforeAccept: async () => {
      verifyMcpPreparation(token, { actorUserId: actorUser.actorUserId });
      guard();
    } }, { actor });
    return { destination: `/projects/${prepared.intent.projectId}?publicationId=${encodeURIComponent(publication.id)}` };
  });
  if ("destination" in result) redirect(result.destination);
  if (result.code === "authentication_required") redirect(`/sign-in?redirect_url=${encodeURIComponent(`/integrations/mcp/confirm?token=${encodeURIComponent(token)}`)}`);
  redirect(`/integrations/mcp/confirm?failure=${encodeURIComponent(result.code)}`);
}
