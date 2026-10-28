"use client";

import { Stack, Text } from "@chakra-ui/react";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@narriflow/ui/components/button";
import { apiErrorMessage } from "@/app/_components/query-mutation-form";
import { useWorkspaceSwitch } from "@/app/_components/workspace-query-gate";

export function OpenWorkspaceButton({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const { switchTo, pending, error } = useWorkspaceSwitch();
  const message = error ? apiErrorMessage(error, "This workspace could not be opened.") : null;
  return (
    <Stack gap="1" align="flex-end" flexShrink={0}>
      <Button
        size="sm"
        variant="subtle"
        bg="bg.panel"
        _hover={{ bg: "bg.muted" }}
        loading={pending}
        onClick={async () => {
          if (await switchTo(workspaceId)) router.push("/home");
        }}
      >
        Open
        <ArrowRight size={14} aria-hidden />
      </Button>
      {message ? <Text role="alert" fontSize="12px" color="danger.fg">{message}</Text> : null}
    </Stack>
  );
}
