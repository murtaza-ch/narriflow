import { notFound } from "next/navigation";
import { Box, Stack } from "@chakra-ui/react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import {
  brandTemplateService,
  brandProfileService,
  BrandTemplateNotFoundError,
} from "@narriflow/services";
import { TemplateForm } from "../../_components/template-form";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditBrandTemplatePage({ params }: PageProps) {
  const { id } = await params;
  const appUser = await admitWorkspacePage("content.view");
  let template;
  try {
    template = await brandTemplateService.get(appUser.workspaceOwnerUserId, id, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
    );
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
              <Button variant="outline" colorPalette="gray" asChild>
                <Link href={returnHref}>Back</Link>
              </Button>
            }
          />
        </Box>
      </Stack>
    );
  }

  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title={`Edit · ${template.name}`}
          description="Changes apply to new projects only."
          actions={
            <Button variant="outline" colorPalette="gray" asChild>
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
        <TemplateForm mode="edit" initialTemplate={template} />
      </Box>
    </Stack>
  );
}
