import { notFound } from "next/navigation";
import { Box, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { workspacesV1EnabledForUser } from "@narriflow/services";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { CreateWorkspaceForm } from "./create-workspace-form";

export default async function NewWorkspacePage() {
  const appUser = await admitSignedInPage("/workspaces/new");
  if (!workspacesV1EnabledForUser(appUser.actorUserId)) notFound();

  return (
    <Box minH="100dvh" bg="bg" color="fg" px={{ base: "6", md: "10" }} py="10">
      <Stack gap="8" maxW="880px" mx="auto">
        <PageHeader
          eyebrow="Workspaces"
          title="Create a Business workspace"
          description="Separate projects, members, and billing."
        />
        <CreateWorkspaceForm />
      </Stack>
    </Box>
  );
}
