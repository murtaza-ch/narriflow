import Link from "next/link";
import { Stack, Text } from "@chakra-ui/react";
import { verifyMcpUploadHandoff } from "@narriflow/mcp-core";
import { hasFeature, isExpectedDomainFailure, workspaceService } from "@narriflow/services";
import { buildMcpContentPack } from "@narriflow/validators";
import { getPrismaClient } from "@narriflow/db/client";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { McpUploadPicker } from "./upload-picker";
import { requireMcpUploadHandoffAdmission } from "@/lib/mcp-upload-handoff";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upload video for your assistant | Narriflow", robots: { index: false, follow: false } };
export default async function McpUploadHandoffPage({ searchParams }: { searchParams: Promise<{ intent?: string }> }) {
  const { intent: token } = await searchParams;
  const user = await admitSignedInPage(`/integrations/mcp/upload?intent=${encodeURIComponent(token ?? "")}`);
  try {
    const state = verifyMcpUploadHandoff(token ?? "", { actorUserId: user.actorUserId, allowAcceptedTransfer: true });
    const actor = await workspaceService.requireActor(user.actorUserId, state.workspaceId, "processing.consume");
    if (actor.status !== "active" || !hasFeature(actor.pricingTier, "integrations.mcp")) return <Text>Active Business access is required for this upload.</Text>;
    await requireMcpUploadHandoffAdmission(state, async () => {
      const prisma = getPrismaClient();
      if (!prisma) throw new Error("Upload Session storage is unavailable");
      return Boolean(await prisma.uploadSession.findFirst({ where: { actorUserId: user.actorUserId, workspaceId: state.workspaceId, clientIdempotencyKey: state.intent.clientIdempotencyKey }, select: { id: true } }));
    });
    const generationContext = { contentPack: buildMcpContentPack(state.intent.generation), languageCode: state.intent.generation.languageCode };
    return <Stack gap="6" maxW="800px"><PageHeader title="Choose a video for your assistant" description="The assistant's generation settings are committed with this upload. File bytes travel directly to Narriflow storage." /><Text fontSize="13px" color="fg.muted">{generationContext.contentPack.clipCountTarget} clips · {generationContext.contentPack.defaultAspectRatio} · {generationContext.contentPack.clipLengthPreset.replaceAll("_", " ")}</Text><McpUploadPicker token={token!} workspaceId={state.workspaceId} clientIdempotencyKey={state.intent.clientIdempotencyKey} title={state.intent.title} generationContext={generationContext} /></Stack>;
  } catch (error) {
    if (!isExpectedDomainFailure(error)) throw error;
    return <Stack gap="4"><PageHeader title="Upload handoff unavailable" description="Open the upload tool again from your assistant. This handoff may have expired or belong to another account." /><Button asChild variant="outline"><Link href="/integrations/mcp">Back to MCP integration</Link></Button></Stack>;
  }
}
