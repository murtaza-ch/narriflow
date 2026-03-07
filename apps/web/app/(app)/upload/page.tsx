import { Box, Heading, Stack, Text } from "@chakra-ui/react";
import { UploadWorkspace } from "./upload-workspace";

export default function UploadPage() {
  return (
    <Box as="section">
      <Stack gap="6">
        <Stack gap="2">
          <Heading size="xl" fontWeight="semibold" letterSpacing="tight">
            Upload Workspace
          </Heading>
          <Text color="fg.muted">
            Import content from direct files, YouTube, or RSS feeds. Ingest progress is available on each project.
          </Text>
        </Stack>
        <UploadWorkspace />
      </Stack>
    </Box>
  );
}
