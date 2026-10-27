import { Box, Stack } from "@chakra-ui/react";
import Link from "next/link";
import { brandCountRequirement, brandProfileService } from "@narriflow/services";
import { planFeatureRequirement, planUpgradeHighlight } from "@narriflow/validators";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { BrandProfileCreateForm } from "../_components/brand-profile-create-form";

export default async function NewBrandProfilePage() {
  const actor = await admitWorkspacePage("brand.manage");
  const profiles = await brandProfileService.list({
    actorUserId: actor.actorUserId,
    workspaceId: actor.workspaceId,
    workspaceOwnerUserId: actor.workspaceOwnerUserId,
    role: actor.role,
    status: actor.status,
    pricingTier: actor.pricingTier,
    isPersonalWorkspace: actor.isPersonalWorkspace,
  });
  const requirement = brandCountRequirement(actor, "brand.profiles", "brandProfiles", profiles.length);
  const upgrade = requirement?.requiredTier
    ? {
        tier: requirement.requiredTier,
        headline: "Upgrade to build a Brand Profile",
        highlight: planUpgradeHighlight(requirement.requiredTier, "brandProfiles"),
      }
    : null;
  // Approval rules are a plan feature (brand-profile.service.ts); below it the field explains the upgrade.
  const governanceRequirement = planFeatureRequirement(actor.pricingTier, "brand.governance");
  const governance = governanceRequirement
    ? {
        message: governanceRequirement.message,
        upgrade: governanceRequirement.requiredTier
          ? {
              tier: governanceRequirement.requiredTier,
              headline: "Upgrade to require approval before publishing",
              highlight: planUpgradeHighlight(governanceRequirement.requiredTier, "brand.governance"),
              canManageBilling: actor.role === "owner",
            }
          : null,
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
      {requirement ? (
        <PlanLimitNotice message={requirement.requiredTier ? requirement.message : `${requirement.message} Delete a profile in Brand kit to add another.`} upgrade={upgrade} canManageBilling={actor.role === "owner"} />
      ) : <BrandProfileCreateForm governance={governance} />}
    </Stack>
  );
}
