"use client";

import { type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { useWorkspaceSwitch } from "@/app/_components/workspace-query-gate";
import { apiErrorMessage } from "@/app/_components/query-mutation-form";

/**
 * Billing pages act on the selected Workspace, and a handoff can name another
 * one: select the handoff's Workspace first, then open `href`.
 */
export function WorkspaceBillingLink({ workspaceId, href, children }: { workspaceId: string; href: string; children: ReactNode }) {
  const router = useRouter();
  const { switchTo, pending, error } = useWorkspaceSwitch();
  return (
    <Stack gap="1">
      <Button asChild aria-busy={pending} opacity={pending ? 0.6 : undefined}>
        <a
          href={href}
          onClick={async (event) => {
            event.preventDefault();
            if (pending) return;
            if (await switchTo(workspaceId)) router.push(href);
          }}
        >
          {children}
        </a>
      </Button>
      {error ? <Text role="alert" fontSize="12px" color="danger.fg">{apiErrorMessage(error, "This workspace could not be opened.")}</Text> : null}
    </Stack>
  );
}
