import Link from "next/link";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { verifyMcpPreparation } from "@narriflow/mcp-core";
import { hasFeature, isExpectedDomainFailure, workspaceService, socialOAuthService } from "@narriflow/services";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { confirmMcpPublication } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Confirm social publication | Narriflow", robots: { index: false, follow: false } };

export default async function McpPublicationConfirmation({ searchParams }: { searchParams: Promise<{ token?: string; declined?: string; failure?: string }> }) {
  const query = await searchParams;
  const actorUser = await admitSignedInPage(`/integrations/mcp/confirm?token=${encodeURIComponent(query.token ?? "")}`);
  if (query.declined || query.failure || !query.token) return <Stack gap="5"><PageHeader title={query.declined ? "Publication declined" : "Confirmation unavailable"} description={query.declined ? "No post was scheduled." : "Ask your assistant to prepare the post again. The confirmation may have expired or workspace access changed."} /><Button asChild variant="outline"><Link href="/integrations/mcp">Back to MCP integration</Link></Button></Stack>;
  let state: ReturnType<typeof verifyMcpPreparation>;
  let destinationAccount = "";
  let workspaceName = "";
  try {
    state = verifyMcpPreparation(query.token, { actorUserId: actorUser.actorUserId });
    const actor = await workspaceService.requireActor(actorUser.actorUserId, state.workspaceId, "publishing.manage");
    if (actor.status !== "active" || !hasFeature(actor.pricingTier, "integrations.mcp")) return <Text>Active Business access is required to confirm this publication.</Text>;
    const intent = state.intent;
    const [accounts, workspace] = await Promise.all([socialOAuthService.listAccounts(actor), workspaceService.getWorkspace(actorUser.actorUserId, state.workspaceId)]);
    const account = accounts.find((account) => account.id === intent.accountId && account.platform === intent.platform);
    destinationAccount = account ? `${account.displayName}${account.handle ? ` (${account.handle})` : ""} · ${account.id}` : `${intent.accountId} · Account unavailable`;
    workspaceName = `${workspace?.name ?? "Workspace"} · ${state.workspaceId}`;
  } catch (error) {
    if (!isExpectedDomainFailure(error)) throw error;
    return <Stack gap="4"><PageHeader title="Confirmation unavailable" description="Prepare this post again from your assistant. This confirmation may have expired or belong to another account." /><Button asChild variant="outline"><Link href="/integrations/mcp">Back to MCP integration</Link></Button></Stack>;
  }
  const intent = state.intent;
  const facts = [["Workspace", workspaceName], ["Destination account", destinationAccount], ["Platform", intent.platform], ["Clip", intent.clipId], ["Editor revision", String(intent.expectedEditorRevision)], ["Export", intent.clipExportId], ["Export variant", intent.clipExportVariantId], ["Output format", `${intent.aspectRatio} · ${intent.resolution}`], ["Scheduled time", intent.scheduledFor], ["Delivery mode", intent.deliveryMode ?? "Direct publication"]];
  return <Stack gap="6" maxW="800px"><PageHeader title="Confirm this exact publication" description="Review the frozen clip revision, destination and caption. Narriflow checks review approval again before scheduling." /><Stack as="dl" gap="3">{facts.map(([label, value]) => <Flex key={label} gap="4" direction={{ base: "column", md: "row" }}><Text as="dt" minW="160px" fontWeight="600">{label}</Text><Text as="dd" fontSize="13px" overflowWrap="anywhere">{value}</Text></Flex>)}</Stack><Stack gap="2"><Text as="h2" fontSize="15px" fontWeight="600">Caption</Text><Text whiteSpace="pre-wrap">{intent.caption}</Text></Stack><Stack gap="2"><Text as="h2" fontSize="15px" fontWeight="600">Provider settings</Text><Text as="pre" fontFamily="mono" fontSize="12px" whiteSpace="pre-wrap" overflowWrap="anywhere">{JSON.stringify(intent.providerSettings, null, 2)}</Text></Stack><Button asChild variant="outline"><Link href={`/projects/${intent.projectId}`}>Review in Narriflow</Link></Button><form action={confirmMcpPublication}><Stack gap="3"><input type="hidden" name="token" value={query.token} /><Text fontSize="13px" color="fg.muted">Confirmation expires at {new Date(state.expiresAtMs).toISOString()}.</Text><Flex gap="3"><Button type="submit" name="decision" value="confirm">Confirm and schedule</Button><Button type="submit" name="decision" value="decline" variant="outline">Decline</Button></Flex></Stack></form></Stack>;
}
