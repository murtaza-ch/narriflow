import { notFound } from "next/navigation";
import { Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { workspacesV1EnabledForUser } from "@narriflow/services";
import { requireWorkspaceAppUser } from "@/lib/workspace";
import { CreateWorkspaceForm } from "./create-workspace-form";

export default async function NewWorkspacePage() {
  const appUser = await requireWorkspaceAppUser();
  if (!workspacesV1EnabledForUser(appUser.actorUserId)) notFound();

  return (
    <Stack gap="8" maxW="880px" mx="auto">
      <PageHeader
        eyebrow="Workspaces"
        title="Create a Business workspace"
        description="Create a separate collaborative space with independent billing, shared usage, and role-based access."
      />
      <CreateWorkspaceForm />
    </Stack>
  );
}
