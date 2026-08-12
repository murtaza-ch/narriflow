import { notFound } from "next/navigation";
import { Box, Stack } from "@chakra-ui/react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { requireWorkspaceAppUser as requireCurrentAppUser } from "@/lib/workspace";
import {
  brandTemplateService,
  BrandTemplateNotFoundError,
} from "@narriflow/services";
import { TemplateForm } from "../_components/template-form";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditBrandTemplatePage({ params }: PageProps) {
  const { id } = await params;
  const appUser = await requireCurrentAppUser();
  let template;
  try {
    template = await brandTemplateService.get(appUser.id, id, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  } catch (error) {
    if (error instanceof BrandTemplateNotFoundError) {
      notFound();
    }
    throw error;
  }

  if (template.isBuiltIn) {
    return (
      <Stack gap="8">
        <Box animation="fade-up" animationFillMode="backwards">
          <PageHeader
            eyebrow="Settings · Brand templates"
            title={template.name}
            description="Built-in templates are read-only. Duplicate to customize."
            actions={
              <Button variant="outline" colorPalette="gray" asChild>
                <Link href="/brand-kit">Back</Link>
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
          eyebrow="Settings · Brand templates"
          title={`Edit · ${template.name}`}
          description="Saved changes apply to new projects only. Existing clips keep their current styling."
          actions={
            <Button variant="outline" colorPalette="gray" asChild>
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
        <TemplateForm mode="edit" initialTemplate={template} />
      </Box>
    </Stack>
  );
}
