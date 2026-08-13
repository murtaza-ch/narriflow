import { Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { workspaceService } from "@narriflow/services";
import { requireWorkspaceAppUser } from "@/lib/workspace";
import { ApiKeysPanel } from "./api-keys-panel";

export default async function ApiSettingsPage() {
  const appUser = await requireWorkspaceAppUser("api.manage");
  const keys = await workspaceService.listApiKeys(appUser.actorUserId, appUser.workspaceId);
  const appOrigin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  return (
    <Stack gap="8">
      <PageHeader eyebrow={appUser.workspace.workspaceName} title="API" description="Create scoped credentials for workspace automation." />
      <ApiKeysPanel
        isBusiness={appUser.workspace.pricingTier === "business"}
        mcpUrl={`${appOrigin}/mcp`}
        keys={keys.map((key) => ({ ...key, createdAt: key.createdAt.toISOString(), lastUsedAt: key.lastUsedAt?.toISOString() ?? null }))}
      />
    </Stack>
  );
}
