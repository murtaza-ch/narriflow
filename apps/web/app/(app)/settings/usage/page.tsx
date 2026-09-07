import { Box, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { StatBand } from "@narriflow/ui/components/stat-band";
import { projectService } from "@narriflow/services";
import { MONTHLY_PROCESSING_MINUTE_LIMITS } from "@narriflow/validators";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";

export default async function UsageSettingsPage() {
  const appUser = await admitWorkspacePage("content.view");
  const [tier, usedMinutes] = await Promise.all([
    projectService.getWorkspacePricingTier(appUser.workspaceId),
    projectService.getWorkspaceMonthlyUsageMinutes(appUser.workspaceId),
  ]);
  const limit = MONTHLY_PROCESSING_MINUTE_LIMITS[tier];
  const percent = Math.min(100, Math.round((usedMinutes / Math.max(1, limit)) * 100),
  );
  return (
    <Stack gap="8">
      <PageHeader eyebrow={appUser.workspace.workspaceName} title="Usage history" />
      <StatBand columns={3}>
        <StatBand.Item label="Plan" value={<Text as="span" textTransform="capitalize">{tier}</Text>} />
        <StatBand.Item label="Minutes used" value={usedMinutes} suffix={<Text textStyle="data" fontSize="13px" color="fg.muted">/ {limit}</Text>} meter={percent} />
        <StatBand.Item label="Remaining" value={Math.max(0, limit - usedMinutes)} suffix={<Text textStyle="data" fontSize="13px" color="fg.muted">min</Text>} />
      </StatBand>
      <Box borderTopWidth="1px" borderColor="border" py="5">
        <Text fontSize="12px" color="fg.muted">Source minutes reset each monthly billing period.</Text>
      </Box>
    </Stack>
  );
}
