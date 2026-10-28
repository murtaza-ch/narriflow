"use client";

import { Box, Stack } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { planUpgradeHighlight } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { BrandLoadFailure, useBrandApi } from "../_components/brand-api";
import { BrandApiProvider, useBrandScope } from "../_components/brand-api-provider";
import { BrandProfileCreateForm } from "../_components/brand-profile-create-form";
import NewBrandProfileLoading from "./loading";

/** Build a Brand Profile: the form, or the plan boundary that stops it, from the Brand kit aggregate. */
export function NewBrandProfileScreen() {
  const scope = useBrandScope();
  if (!scope) return <NewBrandProfileLoading />;
  return (
    <BrandApiProvider key={scope.workspaceId} scope={scope}>
      <NewBrandProfileContent />
    </BrandApiProvider>
  );
}

function NewBrandProfileContent() {
  const router = useRouter();
  const { queries } = useBrandApi();
  const kitQuery = useQuery(queries.kit());
  const data = kitQuery.data;
  const forbidden = data !== undefined && !data.access.canManageBrand;
  // Creating the profile raises the count; the form stays up while the new profile opens.
  const decided = useRef<boolean | null>(null);
  if (data && decided.current === null) decided.current = (data.plan.profiles ?? data.plan.profileCount) === null;

  useEffect(() => {
    if (forbidden) router.replace("/home?requestFailure=capability_denied");
  }, [forbidden, router]);

  if (kitQuery.isError && !data) {
    return <BrandLoadFailure what="Brand Profiles" error={kitQuery.error} onRetry={() => void kitQuery.refetch()} />;
  }
  if (!data || forbidden) return <NewBrandProfileLoading />;

  const { plan, access } = data;
  // Approval rules are a plan feature (brand-profile.service.ts); below it the field explains the upgrade.
  const governance = plan.governance
    ? {
        message: plan.governance.message,
        upgrade: plan.governance.requiredTier
          ? {
              tier: plan.governance.requiredTier,
              headline: "Upgrade to require approval before publishing",
              highlight: planUpgradeHighlight(plan.governance.requiredTier, "brand.governance"),
              canManageBilling: access.canManageBilling,
            }
          : null,
      }
    : null;
  if (decided.current) return <BrandProfileCreateForm governance={governance} />;

  const requirement = plan.profiles ?? plan.profileCount;
  const upgrade = requirement?.requiredTier
    ? {
        tier: requirement.requiredTier,
        headline: "Upgrade to build a Brand Profile",
        highlight: planUpgradeHighlight(requirement.requiredTier, "brandProfiles"),
      }
    : null;
  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="Build a Brand Profile"
          description="Applies to new projects. Add styles and media next."
          actions={<Button variant="subtle" asChild><Link href="/brand-kit">Cancel</Link></Button>}
        />
      </Box>
      <PlanLimitNotice
        message={requirement?.requiredTier ? requirement.message : `${requirement?.message ?? ""} Delete a profile in Brand kit to add another.`}
        upgrade={upgrade}
        canManageBilling={access.canManageBilling}
      />
    </Stack>
  );
}
