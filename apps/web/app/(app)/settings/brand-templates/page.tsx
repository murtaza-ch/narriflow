import { Box, Stack } from "@chakra-ui/react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { requireCurrentAppUser } from "@narriflow/auth";
import { brandTemplateService } from "@narriflow/services";
import { TemplateGallery } from "./_components/template-gallery";

export default async function BrandTemplatesPage() {
  const appUser = await requireCurrentAppUser();
  const data = await brandTemplateService.list(appUser.id);

  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          eyebrow="Settings"
          title="Brand templates"
          description="Pick a style for new clips. Your default is applied to every project unless you choose a different template at upload."
          actions={
            <Button asChild>
              <Link href="/settings/brand-templates/new">New template</Link>
            </Button>
          }
        />
      </Box>
      <Box
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "60ms" }}
      >
        <TemplateGallery
          builtIns={data.builtIns}
          mine={data.mine}
          defaultId={data.defaultId}
        />
      </Box>
    </Stack>
  );
}
