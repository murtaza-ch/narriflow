import { Box, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { CreateWorkspaceForm } from "./create-workspace-form";

export default async function NewWorkspacePage() {
  await admitSignedInPage("/workspaces/new");

  return (
    <Box minH="100dvh" bg="bg" color="fg" px={{ base: "6", md: "10" }} py="10">
      <Stack gap="8" maxW="880px" mx="auto">
        <PageHeader title="Create a Business workspace" />
        <CreateWorkspaceForm />
      </Stack>
    </Box>
  );
}
