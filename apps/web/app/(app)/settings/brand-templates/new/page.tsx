import { Box, Stack } from "@chakra-ui/react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { TemplateForm } from "../_components/template-form";

export default function NewBrandTemplatePage() {
  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          eyebrow="Settings · Brand templates"
          title="New brand template"
          description="Configure your captions, logo, and colors. Templates are applied to clips at upload."
          actions={
            <Button variant="outline" colorPalette="gray" asChild>
              <Link href="/settings/brand-templates">Cancel</Link>
            </Button>
          }
        />
      </Box>
      <Box
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "60ms" }}
      >
        <TemplateForm mode="create" />
      </Box>
    </Stack>
  );
}
