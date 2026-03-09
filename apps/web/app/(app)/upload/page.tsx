import { SectionHeader } from "@narriflow/ui/components/section-header";
import { Stack } from "@chakra-ui/react";
import { UploadWorkspace } from "./upload-workspace";

export default function UploadPage() {
  return (
    <Stack gap="32px">
      <SectionHeader
        title="Upload Workspace"
        description="Import content from direct files, YouTube, or RSS feeds."
      />
      <UploadWorkspace />
    </Stack>
  );
}
