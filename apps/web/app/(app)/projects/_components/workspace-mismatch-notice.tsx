"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Flex, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import type { IdentityScope } from "@narriflow/api-client";
import { selectWorkspaceMutation } from "@narriflow/api-client/session";
import { useMutation } from "@tanstack/react-query";
import { useApiRuntime, useIdentityScope } from "@/app/_components/api-provider";
import { failureMessage } from "../_lib/api";

interface WorkspaceMismatchNoticeProps {
  workspaceId: string;
  workspaceName: string;
  returnTo: string;
}

export function WorkspaceMismatchNotice(props: WorkspaceMismatchNoticeProps) {
  const identity = useIdentityScope();
  return identity ? <SwitchNotice {...props} identity={identity} /> : null;
}

function SwitchNotice({
  workspaceId,
  workspaceName,
  returnTo,
  identity,
}: WorkspaceMismatchNoticeProps & { identity: IdentityScope }) {
  const router = useRouter();
  const runtime = useApiRuntime();
  const [error, setError] = useState<string | null>(null);
  // The selection command changes the scope (and drops the old Workspace's queries)
  // before this navigates, so nothing from the old Workspace is replayed in the new one.
  const select = useMutation({
    ...selectWorkspaceMutation(runtime, identity),
    retry: false,
  });
  const pending = select.isPending;

  async function switchWorkspace() {
    setError(null);
    try {
      await select.mutateAsync(workspaceId);
      router.push(returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/projects");
    } catch (failure) {
      setError(failureMessage(failure, "The Workspace could not be selected."));
    }
  }

  return (
    <Flex
      align={{ base: "stretch", md: "center" }}
      justify="space-between"
      direction={{ base: "column", md: "row" }}
      gap="3"
      py="3"
      px="4"
      borderWidth="1px"
      borderColor="border.card"
      borderRadius="l3"
      bg="bg.panel"
    >
      <Text fontSize="sm">
        This Project belongs to {workspaceName}. Switch Workspaces to open it.
        {error ? ` ${error}` : ""}
      </Text>
      <Button
        size="sm"
        variant="subtle"
        loading={pending}
        onClick={() => void switchWorkspace()}
      >
        Switch Workspace
      </Button>
    </Flex>
  );
}
