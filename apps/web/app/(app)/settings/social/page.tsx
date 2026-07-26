import { Box, Stack } from "@chakra-ui/react";
import { requireCurrentAppUser } from "@narriflow/auth";
import { socialOAuthService } from "@narriflow/services";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { SocialAccountsPanel } from "./social-accounts-panel";

export default async function SocialAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const appUser = await requireCurrentAppUser();
  const [accounts, params] = await Promise.all([
    socialOAuthService.listAccounts(appUser.id),
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
        />
      </Box>
    </Stack>
  );
}
