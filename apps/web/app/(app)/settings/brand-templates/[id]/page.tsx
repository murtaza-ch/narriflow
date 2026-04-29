import { notFound } from "next/navigation";
import { Stack } from "@chakra-ui/react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { SectionHeader } from "@narriflow/ui/components/section-header";
import { requireCurrentAppUser } from "@narriflow/auth";
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
    template = await brandTemplateService.get(appUser.id, id);
  } catch (error) {
    if (error instanceof BrandTemplateNotFoundError) {
      notFound();
    }
    throw error;
  }

  if (template.isBuiltIn) {
    return (
      <Stack gap="24px">
        <SectionHeader
          title={template.name}
          description="Built-in templates are read-only. Duplicate to customize."
          action={
            <Button variant="outline" asChild>
              <Link href="/settings/brand-templates">Back</Link>
            </Button>
          }
        />
      </Stack>
    );
  }

  return (
    <Stack gap="24px">
      <SectionHeader
        title={`Edit · ${template.name}`}
        description="Saved changes apply to new projects only. Existing clips keep their current styling."
        action={
          <Button variant="outline" asChild>
            <Link href="/settings/brand-templates">Cancel</Link>
          </Button>
        }
      />
      <TemplateForm mode="edit" initialTemplate={template} />
    </Stack>
  );
}
