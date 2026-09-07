import { Box, Stack } from "@chakra-ui/react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { TemplateForm } from "../../_components/template-form";

export default function NewBrandTemplatePage() {
  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          title="New style"
          description="Styles apply when you import a video."
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
        <TemplateForm mode="create" />
      </Box>
    </Stack>
  );
}
