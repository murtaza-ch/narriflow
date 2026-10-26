import { Box, Stack } from "@chakra-ui/react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { brandTemplateService } from "@narriflow/services";
import { planCountRequirement, planFeatureRequirement } from "@narriflow/validators";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { TemplateForm } from "../../_components/template-form";
import { PlanLimitNotice } from "../../../_components/plan-limit-notice";

export default async function NewBrandTemplatePage() {
  const actor = await admitWorkspacePage("brand.manage");
  const templates = await brandTemplateService.list(actor);
  const requirement =
    planFeatureRequirement(actor.pricingTier, "brand.customTemplates")?.message ??
    planCountRequirement(actor.pricingTier, "brandTemplates", templates.mine.length)?.message ??
    null;
  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="New style"
          description="Styles apply when you import a video."
          actions={
            <Button variant="subtle" asChild>
              <Link href="/brand-kit">Cancel</Link>
            </Button>
          }
        />
      </Box>
      <Box
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "60ms" }}
      >
        {requirement ? (
          <PlanLimitNotice message={requirement} actionLabel="See plans." canManageBilling={actor.role === "owner"} />
        ) : (
          <TemplateForm mode="create" />
        )}
      </Box>
    </Stack>
  );
}
