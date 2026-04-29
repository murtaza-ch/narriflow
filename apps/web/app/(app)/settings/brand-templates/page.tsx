import { Stack } from "@chakra-ui/react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { SectionHeader } from "@narriflow/ui/components/section-header";
import { requireCurrentAppUser } from "@narriflow/auth";
import { brandTemplateService } from "@narriflow/services";
import { TemplateGallery } from "./_components/template-gallery";

export default async function BrandTemplatesPage() {
  const appUser = await requireCurrentAppUser();
  const data = await brandTemplateService.list(appUser.id);

  return (
    <Stack gap="28px">
      <SectionHeader
        title="Brand templates"
        description="Pick a style for new clips. Your default is applied to every project unless you choose a different template at upload."
        action={
          <Button asChild>
            <Link href="/settings/brand-templates/new">New template</Link>
          </Button>
        }
      />
      <TemplateGallery
        builtIns={data.builtIns}
        mine={data.mine}
        defaultId={data.defaultId}
      />
    </Stack>
  );
}
