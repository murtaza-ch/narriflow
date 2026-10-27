import Link from "next/link";
import { Text } from "@chakra-ui/react";
import {
  roleHasWorkspaceCapability,
  workspaceAllowsCapability,
  type WorkspaceAccessRole,
  type WorkspaceAccessStatus,
  type WorkspaceCapability,
} from "@narriflow/validators";

export interface WorkspaceAccess {
  role: WorkspaceAccessRole;
  status: WorkspaceAccessStatus;
}

const ROLES: readonly WorkspaceAccessRole[] = ["owner", "admin", "editor", "viewer"];

/** "the workspace owner", "a workspace owner or admin", "a workspace owner, admin or editor". */
function whoCan(capability: WorkspaceCapability): string {
  const roles = ROLES.filter((role) => roleHasWorkspaceCapability(role, capability));
  if (roles.length <= 1) return "the workspace owner";
  return `a workspace ${roles.slice(0, -1).join(", ")} or ${roles.at(-1)}`;
}

/**
 * Why `access` can't use `capability`, read from the same matrix the server
 * admits with, or `null` when it can. A billing hold names billing (owners get
 * the billing page); a role names who to ask. Never an upgrade.
 */
export function workspaceAccessReason(
  access: WorkspaceAccess,
  capability: WorkspaceCapability,
  action: string,
): { message: string; billingLink: boolean } | null {
  if (workspaceAllowsCapability(access, capability)) return null;
  if (access.status !== "active" && roleHasWorkspaceCapability(access.role, capability)) {
    const pending = access.status === "pending_payment";
    if (access.role === "owner") {
      return { message: `${pending ? "Finish billing setup" : "Fix billing"} to ${action}.`, billingLink: true };
    }
    return {
      message: `${pending ? "This workspace is waiting on payment" : "This workspace is restricted"}. Ask the workspace owner to ${pending ? "finish billing" : "fix billing"}.`,
      billingLink: false,
    };
  }
  return { message: `Ask ${whoCan(capability)} to ${action}.`, billingLink: false };
}

/** Visible one-line reason next to an action this member can't take. */
export function AccessNote({
  access,
  capability,
  action,
  ...rest
}: {
  access: WorkspaceAccess;
  capability: WorkspaceCapability;
  action: string;
} & React.ComponentProps<typeof Text>) {
  const reason = workspaceAccessReason(access, capability, action);
  if (!reason) return null;
  return (
    <Text fontSize="13px" color="fg.muted" {...rest}>
      {reason.message}
      {reason.billingLink ? (
        <>
          {" "}
          <Link href="/settings/billing">
            <Text as="span" color="fg.accent" textDecoration="underline" textUnderlineOffset="3px">
              Go to billing
            </Text>
          </Link>
        </>
      ) : null}
    </Text>
  );
}
