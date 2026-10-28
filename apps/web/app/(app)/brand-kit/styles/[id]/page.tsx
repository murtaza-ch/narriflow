import { notFound } from "next/navigation";
import { Box, Stack } from "@chakra-ui/react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import {
  brandTemplateService,
  brandFontService,
  brandPlanRequirement,
  brandProfileService,
  BrandTemplateNotFoundError,
} from "@narriflow/services";
import { BrandFontsProvider, type BrandFontChoice } from "../../_components/brand-fonts";
import { TemplateForm } from "../../_components/template-form";
import { planFeatureRequirement, planUpgradeHighlight, workspaceAllowsCapability } from "@narriflow/validators";
import { PlanLimitNotice } from "../../../_components/plan-limit-notice";
import { AccessNote } from "../../../settings/_components/access-note";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditBrandTemplatePage({ params }: PageProps) {
  const { id } = await params;
  const appUser = await admitWorkspacePage("content.view");
  let template;
  try {
    template = await brandTemplateService.get(appUser, id);
  } catch (error) {
    if (error instanceof BrandTemplateNotFoundError) {
      notFound();
    }
    throw error;
  }

  const profileId = await brandProfileService.resolveProfileForTemplate(appUser, id);
  const returnHref = profileId ? `/brand-kit/${profileId}?section=styles&template=${id}` : "/brand-kit?tab=styles";

  if (template.isBuiltIn) {
    return (
      <Stack gap="8">
        <Box animation="fade-up" animationFillMode="backwards">
          <PageHeader
            title={template.name}
            description="Built-in styles are read-only. Duplicate to customize."
            actions={
              <Button variant="subtle" asChild>
                <Link href={returnHref}>Back</Link>
              </Button>
            }
          />
        </Box>
      </Stack>
    );
  }

  // Saving follows brand-template.service.ts update: `brand.manage` and custom styles on the plan.
  const mayEdit = workspaceAllowsCapability({ role: appUser.role, status: appUser.status }, "brand.manage");
  const styleRequirement = planFeatureRequirement(appUser.pricingTier, "brand.customTemplates");
  const fontRequirement = brandPlanRequirement(appUser, "brand.customFonts");
  const activeFonts = await brandFontService.list(appUser);
  const retainedFonts = await brandFontService.resolveReferences(appUser, template.captionPreset.fontAsset ? [template.captionPreset.fontAsset] : []);
  const fonts = [...new Map<string, BrandFontChoice>([...retainedFonts.map((font) => [font.id, { ...font, insertable: false }] as const), ...activeFonts.map((font) => [font.id, { ...font, insertable: true }] as const)]).values()];
  if (mayEdit && !styleRequirement) {
    return (
      <BrandFontsProvider fonts={fonts} requirement={fontRequirement?.message ?? null} upgrade={fontRequirement?.requiredTier ? { tier: fontRequirement.requiredTier, headline: "Upgrade to use custom fonts", canManageBilling: appUser.role === "owner" } : null}>
        <TemplateForm mode="edit" initialTemplate={template} cancelHref={returnHref} />
      </BrandFontsProvider>
    );
  }
  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title={template.name}
          description="Changes apply to new projects only."
          actions={
            <Button variant="subtle" asChild>
              <Link href={returnHref}>Back</Link>
            </Button>
          }
        />
      </Box>
      {!mayEdit ? (
        <AccessNote access={appUser} capability="brand.manage" action="edit this style" />
      ) : styleRequirement ? (
        <PlanLimitNotice
          message={styleRequirement.message}
          upgrade={styleRequirement.requiredTier ? { tier: styleRequirement.requiredTier, headline: "Upgrade to edit your caption styles", highlight: planUpgradeHighlight(styleRequirement.requiredTier, "brand.customTemplates") } : null}
          canManageBilling={appUser.role === "owner"}
        />
      ) : null}
    </Stack>
  );
}
