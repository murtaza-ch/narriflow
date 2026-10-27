"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { switchWorkspaceAction } from "../(app)/_actions/workspace";
import { authenticatedActionResultMessage, isAuthenticatedActionFailure } from "@/lib/authenticated-request-browser";

export function OpenWorkspaceButton({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Stack gap="1" align="flex-end" flexShrink={0}>
      <Button
        size="sm"
        variant="subtle"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await switchWorkspaceAction(workspaceId);
            if (isAuthenticatedActionFailure(result)) {
              setError(authenticatedActionResultMessage(result, "This workspace could not be opened."));
              return;
            }
            router.push("/home");
          })
        }
      >
        Open
      </Button>
      {error ? <Text role="alert" fontSize="12px" color="danger.fg">{error}</Text> : null}
    </Stack>
  );
}
