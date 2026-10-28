"use client";

import { describeApiFailure, type WorkspaceScope } from "@narriflow/api-client";
import {
  type BillingStateData,
  billingKeys,
  billingStateQueryOptions,
  createBillingActions,
  invalidateBillingDependents,
} from "@narriflow/api-client/billing";
import { Box, Grid, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Button } from "@narriflow/ui/components/button";
import {
  billingIntervalSchema,
  paidPricingTierSchema,
  planDefinition,
  type WorkspaceBillingView,
} from "@narriflow/validators";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, CalendarClock, Coins } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { billingViewChangesEntitlements } from "@/lib/billing-view-model";
import { useWorkspaceBootstrap } from "../../_components/usage";
import { StatTile } from "../_components/settings-ui";
import { BillingPlans, type BillingPlansApi } from "./billing-plans";
import BillingLoading from "./loading";

function reveal(index: number) {
  return {
    animation: "fade-up",
    animationDelay: `${index * 60}ms`,
    animationFillMode: "backwards",
  } as const;
}

/** Billing & plans for the selected Workspace: scoped reads, no server data and no entitlement from navigation. */
export function BillingScreen() {
  const scope = useWorkspaceScope();
  if (!scope) return <BillingLoading />;
  return <BillingContent key={scope.workspaceId} scope={scope} />;
}

function BillingContent({ scope }: { scope: WorkspaceScope }) {
  const runtime = useApiRuntime();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const stateQuery = useQuery(billingStateQueryOptions({ transport: runtime.transport, scope }));
  const bootstrap = useWorkspaceBootstrap(scope);

  // Anything the verified state changes (plan, access, seats) also changes credits,
  // entitlements and member limits elsewhere, however the new state was read.
  const seenView = useRef<WorkspaceBillingView | undefined>(undefined);
  const view = stateQuery.data?.view;
  useEffect(() => {
    if (!view) return;
    if (billingViewChangesEntitlements(seenView.current, view)) {
      void invalidateBillingDependents(queryClient, scope, { includeState: false });
    }
    seenView.current = view;
  }, [view, queryClient, scope]);

  const api = useMemo<BillingPlansApi>(
    () => ({
      ...createBillingActions(runtime.transport, scope),
      async readState() {
        const state = await queryClient.fetchQuery(
          billingStateQueryOptions({ transport: runtime.transport, scope }),
        );
        return {
          view: state.view,
          ...(state.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: state.retryAfterSeconds }),
        };
      },
    }),
    [runtime.transport, scope, queryClient],
  );

  const onViewChange = useCallback(
    (next: WorkspaceBillingView) => {
      queryClient.setQueryData<BillingStateData>(billingKeys.state(scope), (current) =>
        current ? { ...current, view: next } : current,
      );
    },
    [queryClient, scope],
  );

  if (stateQuery.isError || bootstrap.isError) {
    const failure = describeApiFailure(stateQuery.error ?? bootstrap.error);
    return (
      <Stack gap="4" role="alert" align="flex-start">
        <PageHeader title="Billing & plans" description="Your plan, credits, and subscription." />
        <Text fontSize="13px" color="fg.muted">
          {failure.kind === "offline"
            ? "You appear to be offline. Check your connection and try again."
            : "Billing could not be loaded. Your plan has not changed."}
        </Text>
        <Button
          size="sm"
          variant="subtle"
          onClick={() => {
            void stateQuery.refetch();
            void bootstrap.refetch();
          }}
        >
          Try again
        </Button>
      </Stack>
    );
  }
  if (!stateQuery.data || !bootstrap.data) return <BillingLoading />;

  const billingView = stateQuery.data.view;
  const { usage, capabilities } = bootstrap.data;
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
  }).format(new Date(usage.renewsAt));

  return (
    <Stack gap="8">
      <Box {...reveal(0)}>
        <PageHeader title="Billing & plans" description="Your plan, credits, and subscription." />
      </Box>

      <Grid {...reveal(1)} templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap="3">
        <StatTile
          icon={<BadgeCheck size={14} />}
          label="Current plan"
          value={planDefinition(billingView.plan).name}
          hint={
            billingView.plan === "free"
              ? "No subscription"
              : billingView.interval
                ? `Billed ${billingView.interval === "annual" ? "annually" : "monthly"}`
                : undefined
          }
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
          availableTiers={stateQuery.data.availableTiers}
          isConfigured={stateQuery.data.isConfigured}
          checkoutReturnSessionId={
            params.get("checkout") === "return" ? params.get("session_id") : null
          }
          checkoutCancelled={params.get("checkout") === "cancelled"}
          canManageBilling={capabilities["billing.manage"]}
          focusTier={paidPricingTierSchema.safeParse(params.get("plan")).data ?? null}
          requestedInterval={billingIntervalSchema.safeParse(params.get("interval")).data ?? null}
          api={api}
          onViewChange={onViewChange}
        />
      </Box>
    </Stack>
  );
}
