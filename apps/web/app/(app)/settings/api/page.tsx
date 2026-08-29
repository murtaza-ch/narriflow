import Link from "next/link";
import { Stack } from "@chakra-ui/react";
import { ArrowRight } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { workspaceService } from "@narriflow/services";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { ApiKeysPanel } from "./api-keys-panel";

export default async function ApiSettingsPage() {
  const appUser = await admitWorkspacePage("api.manage");
  const keys = await workspaceService.listApiKeys(appUser.actorUserId, appUser.workspaceId,
  );
  return (
    <Stack gap="8">
      <PageHeader
        eyebrow={appUser.workspace.workspaceName}
        title="Developer access"
        description="Create, inspect, and revoke scoped credentials for workspace automation."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/integrations/mcp">MCP setup guide<ArrowRight size={14} /></Link>
          </Button>
        }
      />
      <ApiKeysPanel
        isBusiness={appUser.workspace.pricingTier === "business"}
        keys={keys.map((key) => ({ ...key, createdAt: key.createdAt.toISOString(), lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        }))}
      />
    </Stack>
  );
}
