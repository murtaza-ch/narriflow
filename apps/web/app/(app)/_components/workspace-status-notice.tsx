import Link from "next/link";
import { Flex, Text } from "@chakra-ui/react";
import type { WorkspaceAccessRole, WorkspaceAccessStatus } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";

/**
 * Why a pending or restricted workspace can't import, publish or edit, shown
 * on every page so hidden actions never go unexplained. Owners get the way
 * out; everyone else is told who can fix it. The billing page explains itself.
 */
export function WorkspaceStatusNotice({
  status,
  role,
  pathname,
}: {
  status: WorkspaceAccessStatus;
  role: WorkspaceAccessRole;
  pathname: string | null;
}) {
  if (status === "active" || pathname?.startsWith("/settings/billing")) return null;
  const owner = role === "owner";
  const message =
    status === "pending_payment"
      ? owner
        ? "Finish checkout to start using this workspace."
        : "This workspace is waiting for payment. Ask the workspace owner to finish checkout."
      : owner
        ? "Imports, publishing and the API are paused until billing is fixed."
        : "Imports and publishing are paused. Ask the workspace owner to fix billing.";
  return (
    <Flex
      role="status"
      align="center"
      justify="space-between"
      gap="4"
      px={{ base: "4", md: "8" }}
      py="2"
      bg={status === "restricted" ? "warning.subtle" : "accent.subtle"}
    >
      <Text fontSize="sm" color="fg">{message}</Text>
      {owner ? (
        <Button size="sm" variant="subtle" flexShrink={0} asChild>
          <Link href="/settings/billing">{status === "pending_payment" ? "Complete setup" : "Manage billing"}</Link>
        </Button>
      ) : null}
    </Flex>
  );
}
