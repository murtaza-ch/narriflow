import { Box, Stack, Text } from "@chakra-ui/react";
import Link from "next/link";
import { brandProfileService, isProgramWriteEnabled } from "@narriflow/services";
import { hasFeature, planCountRequirement } from "@narriflow/validators";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { BrandProfileCreateForm } from "../_components/brand-profile-create-form";

export default async function NewBrandProfilePage() {
  const actor = await admitWorkspacePage("brand.manage");
  const enabled = isProgramWriteEnabled("brand_profiles");
  const profiles = await brandProfileService.list({
    actorUserId: actor.actorUserId,
    workspaceId: actor.workspaceId,
    workspaceOwnerUserId: actor.workspaceOwnerUserId,
    role: actor.role,
    status: actor.status,
    pricingTier: actor.pricingTier,
    isPersonalWorkspace: actor.isPersonalWorkspace,
  });
  const requirement = planCountRequirement(actor.pricingTier, "brandProfiles", profiles.length)?.message ?? null;
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
        <PlanLimitNotice message={requirement} actionLabel="See plans." canManageBilling={actor.role === "owner"} />
      ) : enabled ? <BrandProfileCreateForm governanceAvailable={hasFeature(actor.pricingTier, "brand.governance")} /> : (
        <Box bg="bg.panel" borderRadius="l3" borderWidth="1px" borderColor="border.card" p="7">
          <Text fontSize="14px">Brand Profile creation is paused. Existing profiles and projects remain readable.</Text>
        </Box>
      )}
    </Stack>
  );
}
