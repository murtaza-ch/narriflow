import { Box, Grid, Stack } from "@chakra-ui/react";
import { BadgeCheck, CalendarClock, Coins } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { billingService, projectService } from "@narriflow/services";
import { billingIntervalSchema, paidPricingTierSchema, planDefinition } from "@narriflow/validators";
import { BillingPlans } from "./billing-plans";
import { StatTile } from "../_components/settings-ui";

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
        <PageHeader title="Billing & plans" description="Your plan, credits, and subscription." />
      </Box>

      <Grid {...reveal(1)} templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap="3">
        <StatTile
          icon={<BadgeCheck size={14} />}
          label="Current plan"
          value={planDefinition(tier).name}
          hint={tier === "free" ? "No subscription" : billingView.interval ? `Billed ${billingView.interval === "annual" ? "annually" : "monthly"}` : undefined}
        />
        <StatTile
          icon={<Coins size={14} />}
          label="Credits used this month"
          value={usedCredits + reservedCredits}
          suffix={`/ ${limitCredits}`}
          meter={pct}
          hint={reservedCredits > 0 ? `${reservedCredits} reserved for videos in progress` : undefined}
        />
        <StatTile
          icon={<CalendarClock size={14} />}
          label="Credits remaining"
          value={usage.remainingCredits}
          suffix="credits"
          hint={`Renew ${renewsOn} (UTC)`}
        />
      </Grid>

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
