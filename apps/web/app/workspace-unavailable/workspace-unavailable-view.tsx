"use client";

import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { PauseCircle } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { workspaceCapabilities } from "@narriflow/validators/api/session";
import { ApiProvider } from "@/app/_components/api-provider";
import { SessionGate, useSessionGate } from "@/app/_components/workspace-query-gate";
import { OpenWorkspaceButton } from "./open-workspace-button";

export interface UnavailableWorkspace {
  id: string;
  name: string;
  paused: boolean;
  canOpen: boolean;
}

function initialsOf(name: string) {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "");
  return letters.join("").toUpperCase() || "W";
}

/** What a member sees when the selected workspace is paused: why, and where else to go. */
export function WorkspaceUnavailableView({ workspaces }: { workspaces: UnavailableWorkspace[] }) {
  return (
    <Flex as="main" minH="100dvh" bg="bg.sidebar" direction="column" align="center" justify="center" gap="6" px="4" py="10">
      <Logo size="md" />
      <Stack w="full" maxW="480px" gap="6" p={{ base: "6", sm: "8" }} bg="bg.panel" borderRadius="l3">
        <Stack align="center" textAlign="center" gap="4">
          <Flex boxSize="12" align="center" justify="center" borderRadius="full" bg="warning.subtle" color="warning.fg" aria-hidden>
            <PauseCircle size={22} />
          </Flex>
          <Stack gap="1.5">
            <Heading as="h1" textStyle="title" fontSize="22px">
              This workspace is paused
            </Heading>
            <Text fontSize="14px" color="fg.muted">
              Its billing needs attention, and only the workspace owner can fix it. Ask them to update billing, or open another workspace.
            </Text>
          </Stack>
        </Stack>
        <Stack gap="2">
          {workspaces.map((workspace) => (
            <Flex key={workspace.id} align="center" gap="3" px="3" py="2.5" bg="bg.soft" borderRadius="l2">
              <Flex boxSize="9" flexShrink={0} align="center" justify="center" borderRadius="l1" bg="bg.panel" fontSize="12px" fontWeight="500" color={workspace.canOpen ? "fg" : "fg.subtle"} aria-hidden>
                {initialsOf(workspace.name)}
              </Flex>
              <Box minW="0" flex="1">
                <Text fontSize="14px" fontWeight="500" color={workspace.canOpen ? "fg" : "fg.muted"} truncate>
                  {workspace.name}
                </Text>
                {!workspace.canOpen ? (
                  <Text fontSize="12px" color="fg.subtle">
                    {workspace.paused ? "Paused until the owner resolves billing" : "Not available to your role"}
                  </Text>
                ) : null}
              </Box>
              {workspace.canOpen ? <OpenWorkspaceButton workspaceId={workspace.id} /> : null}
            </Flex>
          ))}
        </Stack>
      </Stack>
    </Flex>
  );
}

function Memberships() {
  const { session } = useSessionGate();
  return (
    <WorkspaceUnavailableView
      workspaces={session.memberships.map((membership) => ({
        id: membership.id,
        name: membership.isPersonal ? "Personal workspace" : membership.name,
        paused: membership.status !== "active",
        canOpen: workspaceCapabilities(membership)["content.view"],
      }))}
    />
  );
}

/** The signed-in person's workspaces, read from the identity bootstrap. */
export function WorkspaceUnavailableScreen() {
  const pending = <Flex minH="100dvh" bg="bg.sidebar" role="status" aria-label="Loading workspaces" />;
  return (
    <ApiProvider fallback={pending}>
      <SessionGate fallback={pending} title="Your workspaces couldn’t load">
        <Memberships />
      </SessionGate>
    </ApiProvider>
  );
}
