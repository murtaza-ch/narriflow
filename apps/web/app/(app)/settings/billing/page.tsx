import { Box, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { StatBand } from "@narriflow/ui/components/stat-band";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { billingService, projectService } from "@narriflow/services";
import { billingIntervalSchema, paidPricingTierSchema, planDefinition } from "@narriflow/validators";
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
  searchParams: Promise<{ checkout?: string; session_id?: string; plan?: string; interval?: string }>;
}) {
  const appUser = await admitWorkspacePage("content.view");
  const [billingView, usage, params] = await Promise.all([
    billingService.readBillingState(appUser.workspaceId),
    projectService.getUsageSummary(appUser),
    searchParams,
  ]);
  const tier = billingView.plan;
  const { usedCredits, reservedCredits, limitCredits } = usage;
  // Credits reserved for videos still importing are spoken for.
  const pct = Math.min(
    100,
    Math.round(((usedCredits + reservedCredits) / Math.max(1, limitCredits)) * 100),
  );
  const renewsOn = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(usage.renewsAt);

  return (
    <Stack gap="8">
      <Box {...reveal(0)}>
        <PageHeader
          title="Billing & plans"
        />
      </Box>

      <Box {...reveal(1)}>
        <StatBand columns={3}>
          <StatBand.Item
            label="Current plan"
            value={planDefinition(tier).name}
          />
          <StatBand.Item
            label="Credits used this month"
            value={usedCredits + reservedCredits}
            suffix={
              <Text fontSize="13px" color="fg.muted" fontVariantNumeric="tabular-nums">
                / {limitCredits}
                {reservedCredits > 0 ? ` · ${reservedCredits} reserved` : ""}
              </Text>
            }
            meter={pct}
            meterPalette={
              pct >= 100 ? "danger" : pct >= 80 ? "warning" : "accent"
            }
          />
          <StatBand.Item
            label="Credits remaining"
            value={usage.remainingCredits}
            suffix={
              <Text fontSize="13px" color="fg.muted">
                renew {renewsOn} (UTC)
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
            params.checkout === "return" ? (params.session_id ?? null) : null
          }
          checkoutCancelled={params.checkout === "cancelled"}
          canManageBilling={appUser.workspace.role === "owner"}
          focusTier={paidPricingTierSchema.safeParse(params.plan).data ?? null}
          requestedInterval={billingIntervalSchema.safeParse(params.interval).data ?? null}
        />
      </Box>
    </Stack>
  );
}
