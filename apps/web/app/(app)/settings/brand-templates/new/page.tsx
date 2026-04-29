import { Stack } from "@chakra-ui/react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { SectionHeader } from "@narriflow/ui/components/section-header";
import { TemplateForm } from "../_components/template-form";

export default function NewBrandTemplatePage() {
  return (
    <Stack gap="24px">
      <SectionHeader
        title="New brand template"
        description="Configure your captions, logo, and colors. Templates are applied to clips at upload."
        action={
          <Button variant="outline" asChild>
            <Link href="/settings/brand-templates">Cancel</Link>
          </Button>
        }
      />
      <TemplateForm mode="create" />
    </Stack>
  );
}
