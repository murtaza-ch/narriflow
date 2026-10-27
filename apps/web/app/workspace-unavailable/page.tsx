import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { listUserWorkspaces } from "@narriflow/auth";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { OpenWorkspaceButton } from "./open-workspace-button";

/**
 * Where a member lands when the selected workspace is paused for billing and
 * only its owner can resolve it. It sits outside the app shell (which needs
 * access to the selected workspace), so there is always a way out.
 */
export default async function WorkspaceUnavailablePage() {
  const actor = await admitSignedInPage("/home");
  const memberships = await listUserWorkspaces(actor.actorUserId);
  const workspaces = memberships.map(({ role, workspace }) => ({
    id: workspace.id,
    name: workspace.personalOwnerUserId ? "Personal workspace" : workspace.name,
    paused: workspace.status !== "active",
    canOpen: workspaceAllowsCapability({ role, status: workspace.status }, "content.view"),
  }));

  return (
    <Box minH="100dvh" bg="bg" color="fg" px={{ base: "6", md: "10" }} py="10">
      <Stack gap="8" maxW="640px" mx="auto">
        <PageHeader
          title="This workspace is paused"
          description="Its billing needs attention, and only the workspace owner can resolve it. Ask them to update billing, or open another workspace."
        />
        <Stack gap="2">
          {workspaces.map((workspace) => (
            <Flex key={workspace.id} align="center" justify="space-between" gap="4" bg="bg.subtle" borderRadius="12px" px="4" py="3">
              <Box minW="0">
                <Text fontSize="14px" fontWeight="500" truncate>{workspace.name}</Text>
                {!workspace.canOpen ? (
                  <Text fontSize="12px" color="fg.muted">
                    {workspace.paused ? "Paused until the owner resolves billing" : "Not available to your role"}
                  </Text>
                ) : null}
              </Box>
              {workspace.canOpen ? <OpenWorkspaceButton workspaceId={workspace.id} /> : null}
            </Flex>
          ))}
        </Stack>
      </Stack>
    </Box>
  );
}
