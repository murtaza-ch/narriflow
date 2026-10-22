"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Input, Stack, Text, chakra } from "@chakra-ui/react";
import { Copy, Mail, Trash2, UserPlus, X } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Select } from "@narriflow/ui/components/select";
import {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  resendInviteAction,
  revokeInviteAction,
} from "../actions";
import {
  BUSINESS_ADDITIONAL_SEAT_PRICE,
  type WorkspaceBillingView,
} from "@narriflow/validators";
import { formatDate } from "@/lib/format";
import { shouldShowSeatSyncStatus } from "@/lib/billing-view-model";
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

type Role = "owner" | "admin" | "editor" | "viewer";

export function MembersPanel({
  members,
  invites,
  actorRole,
  isBusiness,
  workspaceStatus,
  billingView,
}: {
  members: Array<{
    id: string;
    role: Role;
    joinedAt: string;
    user: { id: string; primaryEmail: string | null; firstName: string | null; lastName: string | null };
  }>;
  invites: Array<{
    id: string;
    email: string;
    role: Role;
    expiresAt: string;
    createdAt: string;
  }>;
  actorRole: Role;
  isBusiness: boolean;
  workspaceStatus: "active" | "pending_payment" | "restricted";
  billingView: WorkspaceBillingView;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "editor" | "viewer">("viewer");
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inviteEmailRef = useRef<HTMLInputElement>(null);
  const canManageMembers =
    (actorRole === "owner" || actorRole === "admin") &&
    (workspaceStatus === "active" || actorRole === "owner");
  const canInviteViewer =
    canManageMembers &&
    (isBusiness || workspaceStatus === "restricted");
  const canAddBillable =
    canManageMembers &&
    isBusiness &&
    workspaceStatus === "active" &&
    billingView.health !== "attention_required" &&
    billingView.health !== "payment_action_required";
  const visibleMembers =
    roleFilter === "all"
      ? members
      : members.filter((member) => member.role === roleFilter);
  const editableRoleItems = [
    ...(canAddBillable && actorRole === "owner" ? [{ value: "admin", label: "Admin" }] : []),
    ...(canAddBillable ? [{ value: "editor", label: "Editor" }] : []),
    { value: "viewer", label: "Viewer" },
  ];

  function submitInvite(event: React.FormEvent) {
    event.preventDefault();
    setFeedback(null);
    setInviteUrl(null);
    startTransition(async () => {
      const result = await inviteMemberAction({ email, role });
      if (!result.ok) {
        setFeedback(authenticatedActionResultMessage(result, "The invitation could not be created."));
        inviteEmailRef.current?.focus();
        return;
      }
      setEmail("");
      setInviteUrl(result.inviteUrl);
      setFeedback(
        result.emailSent
          ? "Invitation sent. You can also copy the secure link."
          : "Invitation created, but email delivery is unavailable. Copy the secure link instead.",
      );
      router.refresh();
    });
  }

  function resend(inviteId: string) {
    setFeedback(null);
    setInviteUrl(null);
    startTransition(async () => {
      const result = await resendInviteAction(inviteId);
      if (!result.ok) {
        setFeedback(authenticatedActionResultMessage(result, "The invitation could not be resent."));
        return;
      }
      setInviteUrl(result.inviteUrl);
      setFeedback(
        result.emailSent
          ? "A new invitation was sent; the previous link is now invalid."
          : "A new invitation link was created, but email delivery is unavailable.",
      );
      router.refresh();
    });
  }

  function revoke(inviteId: string) {
    startTransition(async () => {
      const result = await revokeInviteAction(inviteId);
      if (isAuthenticatedActionFailure(result)) {
        setFeedback(
          authenticatedActionResultMessage(
            result,
            "The invitation could not be revoked.",
          ),
        );
        return;
      }
      router.refresh();
    });
  }

  function changeRole(
    memberId: string,
    currentRole: Role,
    nextRole: "admin" | "editor" | "viewer",
  ) {
    if (
      currentRole === "viewer" &&
      nextRole !== "viewer" &&
      !window.confirm(`This role adds a paid seat ($${BUSINESS_ADDITIONAL_SEAT_PRICE.monthlyUsd}/month or $${BUSINESS_ADDITIONAL_SEAT_PRICE.annualUsd}/year). Continue?`)
    ) return;
    setFeedback(null);
    startTransition(async () => {
      const result = await changeMemberRoleAction(memberId, nextRole);
      if (!result.ok) {
        setFeedback(authenticatedActionResultMessage(result, "The role could not be changed."));
      }
      router.refresh();
    });
  }

  function remove(memberId: string, name: string) {
    if (!window.confirm(`Remove ${name} from this workspace?`)) return;
    setFeedback(null);
    startTransition(async () => {
      const result = await removeMemberAction(memberId);
      if (!result.ok) {
        setFeedback(authenticatedActionResultMessage(result, "The member could not be removed."));
      }
      router.refresh();
    });
  }

  return (
    <Stack gap="8">
      <Box as="form" onSubmit={submitInvite} borderRadius="l3" bg="bg.panel" borderWidth="1px" borderColor="border.card" p="6">
        <Stack gap="4">
          <Flex align="center" gap="2"><Box color="fg.muted" display="flex"><UserPlus size={16} /></Box><Text fontSize="16px" fontWeight="500">Invite a member</Text></Flex>
          {!isBusiness && workspaceStatus !== "restricted" ? (
            <Text fontSize="13px" color="fg.muted">Collaboration is available on Business. Your personal workspace remains available on every plan.</Text>
          ) : (
            <Flex direction={{ base: "column", md: "row" }} gap="3" align={{ md: "flex-end" }}>
              <Stack gap="1.5" flex="1">
                <chakra.label htmlFor="invite-email" fontSize="13px" fontWeight="500">Email address</chakra.label>
                <Input ref={inviteEmailRef} id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="teammate@example.com" required disabled={!(role === "viewer" ? canInviteViewer : canAddBillable) || pending} />
              </Stack>
              <Stack gap="1.5" minW="150px">
                <chakra.label htmlFor="invite-role" fontSize="13px" fontWeight="500">Role</chakra.label>
                <Select
                  id="invite-role"
                  value={role}
                  onValueChange={(value) => setRole(value as typeof role)}
                  ariaLabel="Invitation role"
                  disabled={!canInviteViewer || pending}
                  items={editableRoleItems}
                />
              </Stack>
              <Button type="submit" size="sm" disabled={!(role === "viewer" ? canInviteViewer : canAddBillable) || pending}>{pending ? <Spinner size="xs" /> : <Mail size={14} />}Send invite</Button>
            </Flex>
          )}
          {isBusiness ? (
            <Text fontSize="12px" color="fg.subtle">
              {role === "viewer" ? "Viewers are free." : `${role === "admin" ? "Admins" : "Editors"} add $${BUSINESS_ADDITIONAL_SEAT_PRICE.monthlyUsd}/month or $${BUSINESS_ADDITIONAL_SEAT_PRICE.annualUsd}/year after acceptance.`}
            </Text>
          ) : null}
          {feedback ? <Text fontSize="12px" color={inviteUrl ? "fg" : "danger.fg"}>{feedback}</Text> : null}
          {inviteUrl ? (
            <Flex gap="2"><Input value={inviteUrl} readOnly fontSize="12px" /><Button type="button" variant="subtle" size="sm" onClick={() => navigator.clipboard.writeText(inviteUrl)}><Copy size={14} />Copy</Button></Flex>
          ) : null}
        </Stack>
      </Box>

      {shouldShowSeatSyncStatus(billingView, actorRole) ? (
        <Box
          role="status"
          bg={billingView.health === "attention_required" ? "warning.subtle" : "accent.subtle"}
          borderRadius="l3"
          p="5"
        >
          <Text fontWeight="500" fontSize="14px">Paid-seat billing is updating</Text>
          <Text fontSize="13px" color="fg.muted" mt="1">
            Member changes are saved. Narriflow will synchronize {billingView.desiredAdditionalSeats} additional paid {billingView.desiredAdditionalSeats === 1 ? "seat" : "seats"} in the background.
          </Text>
        </Box>
      ) : null}

      <Stack gap="0" bg="bg.panel" borderRadius="l3" borderWidth="1px" borderColor="border.card" p="6">
        <Flex align="center" justify="space-between" gap="3" pb="3">
          <Text fontSize="16px" fontWeight="500">Members</Text>
          <Select ariaLabel="Filter members by role" value={roleFilter} onValueChange={(value) => setRoleFilter(value as Role | "all")} size="sm" w="150px" items={[{ value: "all", label: "All roles" }, { value: "owner", label: "Owners" }, { value: "admin", label: "Admins" }, { value: "editor", label: "Editors" }, { value: "viewer", label: "Viewers" }]} />
        </Flex>
        {visibleMembers.map((member) => {
          const name = [member.user.firstName, member.user.lastName].filter(Boolean).join(" ") || member.user.primaryEmail || "Member";
          return (
            <Flex key={member.id} align="center" gap="3" py="4" borderTopWidth="1px" borderColor="border.subtle">
              <Stack gap="0" flex="1" minW="0"><Text fontSize="14px" fontWeight="500" truncate>{name}</Text><Text fontSize="12px" color="fg.subtle" truncate>{member.user.primaryEmail}</Text></Stack>
              {member.role === "owner" || !canManageMembers || (actorRole === "admin" && member.role === "admin") ? (
                <Text fontSize="13px" color="fg.muted" textTransform="capitalize">{member.role}</Text>
              ) : (
                <Select
                  ariaLabel={`Role for ${name}`}
                  value={member.role}
                  onValueChange={(value) => changeRole(member.id, member.role, value as "admin" | "editor" | "viewer")}
                  size="sm"
                  w="130px"
                  disabled={pending}
                  items={editableRoleItems}
                />
              )}
              {member.role !== "owner" && canManageMembers && !(actorRole === "admin" && member.role === "admin") ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${name}`}
                  onClick={() => remove(member.id, name)}
                  disabled={pending}
                >
                  <Trash2 size={14} />
                </Button>
              ) : null}
            </Flex>
          );
        })}
      </Stack>

      {invites.length > 0 ? (
        <Stack gap="0" bg="bg.panel" borderRadius="l3" borderWidth="1px" borderColor="border.card" p="6">
          <Text fontSize="16px" fontWeight="500" pb="3">Pending invitations</Text>
          {invites.map((invite) => (
            <Flex key={invite.id} align="center" gap="3" py="4" borderTopWidth="1px" borderColor="border.subtle">
              <Stack gap="0" flex="1" minW="0"><Text fontSize="14px" fontWeight="500" truncate>{invite.email}</Text><Text fontSize="12px" color={new Date(invite.expiresAt) <= new Date() ? "danger.fg" : "fg.subtle"}>{new Date(invite.expiresAt) <= new Date() ? "Expired" : `Expires ${formatDate(invite.expiresAt)}`}</Text></Stack>
              <Text fontSize="13px" color="fg.muted" textTransform="capitalize">{invite.role}</Text>
              {canManageMembers ? <Button size="sm" variant="ghost" onClick={() => resend(invite.id)} disabled={pending}><Mail size={14} />Resend</Button> : null}
              {canManageMembers ? <Button size="sm" variant="ghost" aria-label={`Revoke invitation for ${invite.email}`} onClick={() => revoke(invite.id)} disabled={pending}><X size={14} /></Button> : null}
            </Flex>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}
