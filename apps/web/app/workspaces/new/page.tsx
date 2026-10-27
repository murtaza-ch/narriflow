import { Box, Stack } from "@chakra-ui/react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { CreateWorkspaceForm } from "./create-workspace-form";

export default async function NewWorkspacePage() {
  await admitSignedInPage("/workspaces/new");

  return (
    <Box minH="100dvh" bg="bg" color="fg" px={{ base: "6", md: "10" }} py="10">
      <Stack gap="8" maxW="880px" mx="auto">
        <Button variant="ghost" size="sm" alignSelf="flex-start" ms="-3" asChild>
          <Link href="/home"><ArrowLeft size={14} aria-hidden />Back to Narriflow</Link>
        </Button>
        <PageHeader title="Create a Business workspace" />
        <CreateWorkspaceForm />
      </Stack>
    </Box>
  );
}
