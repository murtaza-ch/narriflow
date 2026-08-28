import { Box, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { StatBand } from "@narriflow/ui/components/stat-band";
import { requireWorkspaceAppUser as requireCurrentAppUser } from "@/lib/workspace";
import { billingService, projectService } from "@narriflow/services";
import { MONTHLY_PROCESSING_MINUTE_LIMITS } from "@narriflow/validators";
import { BillingPlans } from "./billing-plans";

function reveal(index: number) {
  return {
    animation: "fade-up",
    animationDelay: `${index * 60}ms`,
    animationFillMode: "backwards",
  } as const;
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; session_id?: string }>;
}) {
  const appUser = await requireCurrentAppUser();
  const [billingView, usedMinutes, params] = await Promise.all([
    billingService.readBillingState(appUser.workspaceId),
    projectService.getWorkspaceMonthlyUsageMinutes(appUser.workspaceId),
    searchParams,
  ]);
  const tier = billingView.plan;
  const limitMinutes = MONTHLY_PROCESSING_MINUTE_LIMITS[tier];
  const pct = Math.min(
    100,
    Math.round((usedMinutes / Math.max(1, limitMinutes)) * 100),
  );
  const remaining = Math.max(0, limitMinutes - usedMinutes);

  return (
    <Stack gap="8">
      <Box {...reveal(0)}>
        <PageHeader
          eyebrow="Settings"
          title="Billing & plans"
          description="Manage your subscription and track your monthly processing usage."
        />
      </Box>

      <Box {...reveal(1)}>
        <StatBand columns={3}>
          <StatBand.Item
            label="Current plan"
            value={
              <Text as="span" textTransform="capitalize">
                {tier}
              </Text>
            }
          />
          <StatBand.Item
            label="Used this month"
            value={usedMinutes}
            suffix={
              <Text textStyle="data" fontSize="13px" color="fg.muted">
                / {limitMinutes} min
              </Text>
            }
            meter={pct}
            meterPalette={
              pct >= 100 ? "danger" : pct >= 80 ? "warning" : "accent"
            }
          />
          <StatBand.Item
            label="Remaining"
            value={remaining}
            suffix={
              <Text textStyle="data" fontSize="13px" color="fg.muted">
                min
              </Text>
            }
          />
        </StatBand>
      </Box>

      <Box {...reveal(2)}>
        <BillingPlans
          initialView={billingView}
          availableTiers={billingService.configuredTiers()}
          isConfigured={billingService.isConfigured()}
          checkoutReturnSessionId={
            params.checkout === "return" ? params.session_id ?? null : null
          }
          checkoutCancelled={params.checkout === "cancelled"}
          canManageBilling={appUser.workspace.role === "owner"}
        />
      </Box>
    </Stack>
  );
}
