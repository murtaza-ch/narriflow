"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { switchWorkspaceAction } from "../../_actions/workspace";
import { authenticatedActionResultMessage, isAuthenticatedActionFailure } from "@/lib/authenticated-request-browser";

/**
 * Billing pages act on the selected Workspace, and a handoff can name another
 * one: select the handoff's Workspace first, then open `href`.
 */
export function WorkspaceBillingLink({ workspaceId, href, children }: { workspaceId: string; href: string; children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Stack gap="1">
      <Button asChild aria-busy={pending} opacity={pending ? 0.6 : undefined}>
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault();
            if (pending) return;
            startTransition(async () => {
              const result = await switchWorkspaceAction(workspaceId);
              if (isAuthenticatedActionFailure(result)) {
                setError(authenticatedActionResultMessage(result, "This workspace could not be opened."));
                return;
              }
              router.push(href);
            });
          }}
        >
          {children}
        </a>
      </Button>
      {error ? <Text role="alert" fontSize="12px" color="danger.fg">{error}</Text> : null}
    </Stack>
  );
}
