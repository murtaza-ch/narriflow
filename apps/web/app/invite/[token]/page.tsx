import { Box, Stack, Text } from "@chakra-ui/react";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { workspaceService } from "@narriflow/services";
import { Logo } from "@narriflow/ui/components/logo";
import { Button } from "@narriflow/ui/components/button";
import { acceptWorkspaceInviteAction } from "./actions";
import { AuthenticatedActionForm } from "@/app/_components/authenticated-action-form";

export default async function WorkspaceInvitePage({ params,
}: { params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [, invite] = await Promise.all([
    admitSignedInPage(`/invite/${encodeURIComponent(token)}`), workspaceService.getInvitePreview(token),
  ]);
  if (!invite) {
    return (
      <Stack minH="100dvh" align="center" justify="center" p="6"><Logo size="md" /><Box maxW="460px" textAlign="center"><Text textStyle="title">Invitation unavailable</Text><Text mt="2" fontSize="13px" color="fg.muted">This link has expired, was revoked, or was already accepted.</Text></Box></Stack>
    );
  }
  const action = acceptWorkspaceInviteAction.bind(null, token);
  return (
    <Stack minH="100dvh" align="center" justify="center" p="6" bg="bg">
      <Logo size="md" />
      <Box maxW="480px" w="full" borderTopWidth="1px" borderColor="border" pt="8" textAlign="center">
        <Text textStyle="eyebrow" color="fg.subtle">Workspace invitation</Text>
        <Text textStyle="title" fontSize="28px" mt="2">Join {invite.workspace.name}</Text>
        <Text fontSize="13px" color="fg.muted" mt="3">You&apos;ll join as {invite.role}. Your personal workspace and its subscription remain separate.</Text>
        <AuthenticatedActionForm action={action}><Button type="submit" mt="6">Accept invitation</Button></AuthenticatedActionForm>
      </Box>
    </Stack>
  );
}
