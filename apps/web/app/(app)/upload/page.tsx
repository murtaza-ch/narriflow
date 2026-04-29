import { SectionHeader } from "@narriflow/ui/components/section-header";
import { Stack } from "@chakra-ui/react";
import { requireCurrentAppUser } from "@narriflow/auth";
import { brandTemplateService } from "@narriflow/services";
import { UploadShell } from "./_components/upload-shell";

export default async function UploadPage() {
  const appUser = await requireCurrentAppUser();
  const brandTemplates = await brandTemplateService.list(appUser.id);

  return (
    <Stack gap="28px">
      <SectionHeader
        title="Import or upload"
        description="Drop a video, paste a YouTube link, or pick from an RSS feed — and get clips in one click."
      />
      <UploadShell brandTemplates={brandTemplates} />
    </Stack>
  );
}
