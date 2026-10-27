import Link from "next/link";
import { Stack, Text } from "@chakra-ui/react";
import { verifyMcpUploadHandoff } from "@narriflow/mcp-core";
import { integrationUploadSessionKey, isExpectedDomainFailure, recipeService, workspaceService } from "@narriflow/services";
import { buildGenerationContext } from "@narriflow/validators";
import { getPrismaClient } from "@narriflow/db/client";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { ConnectorUnavailable, connectorUnavailableReason } from "../connector-unavailable";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { McpUploadPicker } from "./upload-picker";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upload video for your assistant | Narriflow", robots: { index: false, follow: false } };
export default async function McpUploadHandoffPage({ searchParams }: { searchParams: Promise<{ intent?: string }> }) {
  const { intent: token } = await searchParams;
  const user = await admitSignedInPage(`/integrations/mcp/upload?intent=${encodeURIComponent(token ?? "")}`);
  try {
    const state = verifyMcpUploadHandoff(token ?? "", { actorUserId: user.actorUserId, allowExpired: true });
    // Read the membership before admitting the upload, so a viewer or a paused or
    // downgraded Workspace is told why instead of seeing an expired handoff.
    const member = await workspaceService.findActor(user.actorUserId, state.workspaceId);
    if (member && connectorUnavailableReason(member, "processing.consume")) return <ConnectorUnavailable workspace={member} capability="processing.consume" action="Uploading for your assistant" />;
    const actor = await workspaceService.requireActor(user.actorUserId, state.workspaceId, "processing.consume");
    // An expired handoff can only resume this person's existing upload; the
    // upload route refuses a new open after expiry.
    const resumeOnly = Date.now() >= state.expiresAtMs;
    if (resumeOnly) {
      const prisma = getPrismaClient();
      if (!prisma) throw new Error("Upload Session storage is unavailable");
      const existing = await prisma.uploadSession.findFirst({ where: { actorUserId: user.actorUserId, workspaceId: state.workspaceId, clientIdempotencyKey: integrationUploadSessionKey(user.actorUserId, state.intent.clientIdempotencyKey) }, select: { id: true } });
      if (!existing) verifyMcpUploadHandoff(token ?? "", { actorUserId: user.actorUserId });
    }
    // A Recipe is read when the upload opens; this page only names it. An
    // expired handoff resumes without it.
    const recipe = state.intent.recipeId && !resumeOnly ? await recipeService.get(actor, state.intent.recipeId) : null;
    const generationContext = state.intent.recipeId ? undefined : buildGenerationContext(state.intent.generation, state.intent.finishing);
    return <Stack gap="6" maxW="800px"><PageHeader title="Choose a video for your assistant" description="The assistant's generation settings are committed with this upload. File bytes travel directly to Narriflow storage." />{generationContext ? <Text fontSize="13px" color="fg.muted">{generationContext.contentPack.clipCountTarget} clips · {generationContext.contentPack.defaultAspectRatio} · {generationContext.contentPack.clipLengthPreset.replaceAll("_", " ")}</Text> : recipe ? <Text fontSize="13px" color="fg.muted">Recipe: {recipe.name}</Text> : null}<McpUploadPicker token={token!} workspaceId={state.workspaceId} clientIdempotencyKey={state.intent.clientIdempotencyKey} title={state.intent.title} brandProfileId={state.intent.brandProfileId} recipeId={state.intent.recipeId} resumeOnly={resumeOnly} generationContext={generationContext} /></Stack>;
  } catch (error) {
    if (!isExpectedDomainFailure(error)) throw error;
    return <Stack gap="4"><PageHeader title="Upload handoff unavailable" description="Open the upload tool again from your assistant. This handoff may have expired or belong to another account." /><Button asChild variant="subtle"><Link href="/integrations/mcp">Back to MCP integration</Link></Button></Stack>;
  }
}
