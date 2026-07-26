import { Box, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { requireCurrentAppUser } from "@narriflow/auth";
import { brandTemplateService } from "@narriflow/services";
import { UploadShell } from "./_components/upload-shell";

export default async function UploadPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string | string[] }>;
}) {
  const appUser = await requireCurrentAppUser();
  const [brandTemplates, params] = await Promise.all([
    brandTemplateService.list(appUser.id),
    searchParams,
  ]);
  const rawUrl = Array.isArray(params.url) ? params.url[0] : params.url;

  return (
    <Stack gap="8" maxW="1080px" mx="auto">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          eyebrow="Ingest"
          title="Import or upload"
          description="Drop a video, paste a video link or RSS feed — and get clips in one click."
        />
      </Box>
      <Box
        animation="fade-up"
        style={{ animationDelay: "60ms" }}
        animationFillMode="backwards"
      >
        <UploadShell brandTemplates={brandTemplates} initialUrl={rawUrl ?? null} />
      </Box>
    </Stack>
  );
}
