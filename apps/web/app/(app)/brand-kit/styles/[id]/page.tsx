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
  const returnHref = profileId ? `/brand-kit/${profileId}?section=styles&template=${id}` : "/brand-kit";

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

  const fontRequirement = brandPlanRequirement(appUser, "brand.customFonts");
  const activeFonts = await brandFontService.list(appUser);
  const retainedFonts = await brandFontService.resolveReferences(appUser, template.captionPreset.fontAsset ? [template.captionPreset.fontAsset] : []);
  const fonts = [...new Map<string, BrandFontChoice>([...retainedFonts.map((font) => [font.id, { ...font, insertable: false }] as const), ...activeFonts.map((font) => [font.id, { ...font, insertable: true }] as const)]).values()];
  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title={`Edit · ${template.name}`}
          description="Changes apply to new projects only."
          actions={
            <Button variant="subtle" asChild>
              <Link href={returnHref}>Cancel</Link>
            </Button>
          }
        />
      </Box>
      <Box
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "60ms" }}
      >
        <BrandFontsProvider fonts={fonts} requirement={fontRequirement?.message ?? null} upgrade={fontRequirement?.requiredTier ? { tier: fontRequirement.requiredTier, headline: "Upgrade to use custom fonts", canManageBilling: appUser.role === "owner" } : null}><TemplateForm mode="edit" initialTemplate={template} /></BrandFontsProvider>
      </Box>
    </Stack>
  );
}
