import { Box, Stack } from "@chakra-ui/react";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { socialOAuthService } from "@narriflow/services";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { SocialAccountsPanel } from "./social-accounts-panel";

export default async function SocialAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const appUser = await admitWorkspacePage("content.view");
  const [accounts, params] = await Promise.all([
    socialOAuthService.listAccounts(appUser.workspaceOwnerUserId, appUser.workspaceId,
    ),
    searchParams,
  ]);

  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          eyebrow="Settings"
          title="Social accounts"
          description="Connect native OAuth accounts for scheduled posting to TikTok, YouTube Shorts, Instagram Reels, LinkedIn, and X."
        />
      </Box>
      <Box
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "60ms" }}
      >
        <SocialAccountsPanel
          accounts={accounts}
          connectedCount={params.connected ? Number(params.connected) : null}
          errorCode={params.error ?? null}
          canManage={appUser.workspace.role === "owner" || appUser.workspace.role === "admin"}
        />
      </Box>
    </Stack>
  );
}
