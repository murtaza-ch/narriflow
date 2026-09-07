"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Flex, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { switchWorkspaceAction } from "../../_actions/workspace";
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

export function WorkspaceMismatchNotice({
  workspaceId,
  workspaceName,
  returnTo,
}: {
  workspaceId: string;
  workspaceName: string;
  returnTo: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Flex
      align={{ base: "stretch", md: "center" }}
      justify="space-between"
      direction={{ base: "column", md: "row" }}
      gap="3"
      py="3"
      px="4"
      bg="bg.subtle"
    >
      <Text fontSize="sm">
        This Project belongs to {workspaceName}. Switch Workspaces to open it.
        {error ? ` ${error}` : ""}
      </Text>
      <Button
        size="sm"
        variant="outline"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            try {
              const result = await switchWorkspaceAction(workspaceId);
              if (isAuthenticatedActionFailure(result)) {
                setError(
                  authenticatedActionResultMessage(
                    result,
                    "The Workspace could not be selected.",
                  ),
                );
                return;
              }
              router.push(
                returnTo.startsWith("/") && !returnTo.startsWith("//")
                  ? returnTo
                  : "/projects",
              );
              router.refresh();
            } catch {
              setError("The Workspace could not be switched.");
            }
          })
        }
      >
        Switch Workspace
      </Button>
    </Flex>
  );
}
