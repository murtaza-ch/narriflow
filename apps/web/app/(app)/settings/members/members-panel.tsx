"use client";

import { UpgradeHero } from "../../_components/upgrade";
import { TeamVisual } from "../../_components/upgrade-visuals";
import { useMemo, useRef, useState } from "react";
import { Box, Flex, Input, Stack, Text } from "@chakra-ui/react";
import type { WorkspaceScope } from "@narriflow/api-client";
import {
  changeMemberRoleMutation,
  inviteMemberMutation,
  invalidateWorkspaceMembers,
  removeMemberMutation,
  resendInviteMutation,
  revokeInviteMutation,
} from "@narriflow/api-client/workspace";
import { useMutation } from "@tanstack/react-query";
import { Clock, Copy, Mail, Trash2, UserPlus, Users, X } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Select } from "@narriflow/ui/components/select";
import { useApiRuntime } from "@/app/_components/api-provider";
import { apiErrorMessage } from "@/app/_components/query-mutation-form";
import {
  BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS,
  formatUsdCents,
  lowestTierWithFeature,
  planUpgradeHighlight,
  workspaceAllowsCapability,
  type WorkspaceBillingView,
} from "@narriflow/validators";
import Link from "next/link";
import { AccessNote } from "../_components/access-note";
import { SettingsCard } from "../_components/settings-ui";
import { formatDate } from "@/lib/format";
import { shouldShowSeatSyncStatus } from "@/lib/billing-view-model";

type Role = "owner" | "admin" | "editor" | "viewer";

// A fixed zone keeps the server and browser renders identical.
const JOINED_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function initials(first: string | null, last: string | null, email: string | null) {
  const fromName = `${first?.trim().charAt(0) ?? ""}${last?.trim().charAt(0) ?? ""}`;
  return (fromName || email?.trim().charAt(0) || "?").toUpperCase();
}

/** A person as a soft circle with their initials. */
function MemberAvatar({ label, icon }: { label?: string; icon?: React.ReactNode }) {
  return (
    <Flex boxSize="9" flexShrink={0} borderRadius="full" bg="bg.soft" color="fg" align="center" justify="center" fontSize="12.5px" fontWeight="600" aria-hidden="true">
      {icon ?? label}
    </Flex>
  );
}

function RolePill({ role }: { role: Role }) {
  return (
    <Text as="span" display="inline-flex" alignItems="center" h="6" px="2.5" borderRadius="full" bg="bg.soft" fontSize="12px" fontWeight="500" color="fg" textTransform="capitalize" flexShrink={0}>
      {role}
    </Text>
  );
}

function SummaryChip({ value, label }: { value: number; label: string }) {
  return (
    <Flex align="center" gap="1.5" h="7" px="2.5" borderRadius="full" bg="bg.subtle" fontSize="12px" color="fg.muted">
      <Text as="span" color="fg" fontWeight="500" fontVariantNumeric="tabular-nums">
        {value}
      </Text>
      {label}
    </Flex>
  );
}

function BillingLink() {
  return (
    <Link href="/settings/billing">
      <Text as="span" color="fg.accent" textDecoration="underline" textUnderlineOffset="3px">Go to billing</Text>
    </Link>
  );
}

export function MembersPanel({
  scope,
  members,
  invites,
  actorRole,
  isBusiness,
  workspaceStatus,
  billingView,
}: {
  /** The Workspace these members belong to; every command is bound to it. */
  scope: WorkspaceScope;
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
  const runtime = useApiRuntime();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "editor" | "viewer">("viewer");
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const inviteEmailRef = useRef<HTMLInputElement>(null);
  // One idempotency intent per form (and per row for resend), so a retry after a
  // lost response replays the same invitation instead of sending a second one.
  const invite = useMutation(useMemo(() => inviteMemberMutation(runtime, scope), [runtime, scope]));
  const resendInvite = useMutation(useMemo(() => resendInviteMutation(runtime, scope), [runtime, scope]));
  const revokeInvite = useMutation(useMemo(() => revokeInviteMutation(runtime, scope), [runtime, scope]));
  const changeRoleCommand = useMutation(useMemo(() => changeMemberRoleMutation(runtime, scope), [runtime, scope]));
  const removeMemberCommand = useMutation(useMemo(() => removeMemberMutation(runtime, scope), [runtime, scope]));
  const pending =
    invite.isPending ||
    resendInvite.isPending ||
    revokeInvite.isPending ||
    changeRoleCommand.isPending ||
    removeMemberCommand.isPending;
  // A role change or removal that failed may still have landed (or conflicted
  // with a concurrent change), so the lists are read again either way.
  const rereadMembers = () => void invalidateWorkspaceMembers(runtime.queryClient, scope);
  // The capability every member action admits with: a pending workspace's
  // owner can't manage members yet, a restricted one can remove or demote.
  const canManageMembers = workspaceAllowsCapability({ role: actorRole, status: workspaceStatus }, "members.invite");
  // Every invitation, Viewers included, needs the team entitlement and an
  // active workspace; a restricted workspace can only remove or demote members.
  const canInviteViewer =
    canManageMembers && isBusiness && workspaceStatus === "active";
  const canAddBillable =
    canInviteViewer &&
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

  function failed(error: unknown, fallback: string) {
    const text = apiErrorMessage(error, fallback);
    setFeedback(text === null ? null : { text, ok: false });
  }

  function submitInvite(event: React.FormEvent) {
    event.preventDefault();
    setFeedback(null);
    setInviteUrl(null);
    invite.mutate(
      { email, role },
      {
        onSuccess: (result) => {
          setEmail("");
          setInviteUrl(result.inviteUrl);
          setFeedback({
            ok: true,
            text:
              result.emailSent === null
                ? "This invitation was already created. Use Resend to send a fresh link."
                : result.emailSent
                  ? "Invitation sent. You can also copy the secure link."
                  : "Invitation created, but email delivery is unavailable. Copy the secure link instead.",
          });
        },
        onError: (error) => {
          failed(error, "The invitation could not be created.");
          inviteEmailRef.current?.focus();
        },
      },
    );
  }

  function resend(inviteId: string) {
    setFeedback(null);
    setInviteUrl(null);
    resendInvite.mutate(inviteId, {
      onSuccess: (result) => {
        setInviteUrl(result.inviteUrl);
        setFeedback({
          ok: true,
          text:
            result.emailSent === null
              ? "This invitation was already resent. Check the recipient's inbox."
              : result.emailSent
                ? "A new invitation was sent; the previous link is now invalid."
                : "A new invitation link was created, but email delivery is unavailable.",
        });
      },
      onError: (error) => failed(error, "The invitation could not be resent."),
    });
  }

  function revoke(inviteId: string) {
    revokeInvite.mutate(inviteId, {
      onError: (error) => failed(error, "The invitation could not be revoked."),
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
      !window.confirm(`This role adds a paid seat (${formatUsdCents(BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS.monthly)}/month or ${formatUsdCents(BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS.annual)}/year). Continue?`)
    ) return;
    setFeedback(null);
    changeRoleCommand.mutate(
      { memberId, role: nextRole },
      {
        onError: (error) => {
          failed(error, "The role could not be changed.");
          rereadMembers();
        },
      },
    );
  }

  function remove(memberId: string, name: string) {
    if (!window.confirm(`Remove ${name} from this workspace?`)) return;
    setFeedback(null);
    removeMemberCommand.mutate(memberId, {
      onError: (error) => {
        failed(error, "The member could not be removed.");
        rereadMembers();
      },
    });
  }

  const viewers = members.filter((member) => member.role === "viewer").length;
  const inviteHint =
    workspaceStatus !== "active" ? (
      <Text fontSize="12px" color="fg.subtle">
        Invitations are unavailable until billing is active. You can still remove or change members.{" "}
        <BillingLink />
      </Text>
    ) : !canAddBillable ? (
      <Text fontSize="12px" color="fg.subtle">
        {actorRole === "owner" ? (
          <>Admins and editors are paid seats, so they wait until billing is current. <BillingLink /></>
        ) : (
          "Admins and editors are paid seats, so they wait until billing is current. Ask the workspace owner to update billing."
        )}
      </Text>
    ) : (
      <Text fontSize="12px" color="fg.subtle">
        {role === "viewer" ? "Viewers are free." : `${role === "admin" ? "Admins" : "Editors"} add ${formatUsdCents(BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS.monthly)}/month or ${formatUsdCents(BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS.annual)}/year after acceptance.`}
      </Text>
    );

  return (
    <Stack gap="6">
      {isBusiness ? (
        <Flex gap="2" wrap="wrap">
          <SummaryChip value={members.length} label={members.length === 1 ? "member" : "members"} />
          <SummaryChip value={billingView.desiredAdditionalSeats} label={billingView.desiredAdditionalSeats === 1 ? "paid seat" : "paid seats"} />
          <SummaryChip value={viewers} label={`${viewers === 1 ? "viewer" : "viewers"}, free`} />
          {invites.length > 0 ? <SummaryChip value={invites.length} label="pending" /> : null}
        </Flex>
      ) : null}
      {!isBusiness ? (
        workspaceStatus === "restricted" ? (
          <Text fontSize="13px" color="fg.muted">
            Billing needs attention before you can add a team.{" "}
            {actorRole === "owner" ? <BillingLink /> : "Ask the workspace owner to fix billing."}
          </Text>
        ) : (
        <UpgradeHero
          title="Bring your team into one workspace"
          points={["Invite admins and editors, and add viewers for free.", "Share brand approval rules and client review rooms."]}
          ctaLabel="Upgrade to invite your team"
          visual={<TeamVisual />}
          prompt={{
            tier: lowestTierWithFeature("workspace.members"),
            headline: "Upgrade to work with your team",
            highlight: planUpgradeHighlight(lowestTierWithFeature("workspace.members") ?? "business", "workspace.members"),
            canManageBilling: actorRole === "owner",
          }}
        />
        )
      ) : !canManageMembers ? (
        <AccessNote access={{ role: actorRole, status: workspaceStatus }} capability="members.invite" action="invite members" />
      ) : (
      <SettingsCard icon={<UserPlus size={16} />} title="Invite a member" description="They get an email with a secure link to join.">
        <Box as="form" onSubmit={submitInvite}>
          <Stack gap="3">
            <Flex direction={{ base: "column", md: "row" }} gap="2" align={{ md: "center" }}>
              <Flex
                flex="1"
                align="center"
                gap="2.5"
                ps="3"
                bg="bg.soft"
                borderRadius="control"
                borderWidth="1px"
                borderColor="transparent"
                color="fg.muted"
                _focusWithin={{ borderColor: "border.focus" }}
              >
                <Mail size={14} aria-hidden />
                <Input
                  ref={inviteEmailRef}
                  id="invite-email"
                  aria-label="Email address"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="teammate@example.com"
                  required
                  disabled={!(role === "viewer" ? canInviteViewer : canAddBillable) || pending}
                  ps="0"
                  bg="transparent"
                  borderWidth="0"
                  _hover={{ bg: "transparent" }}
                  _focus={{ borderColor: "transparent" }}
                  _focusVisible={{ borderColor: "transparent" }}
                />
              </Flex>
              <Box w={{ base: "full", md: "150px" }} flexShrink={0}>
                <Select
                  id="invite-role"
                  value={role}
                  onValueChange={(value) => setRole(value as typeof role)}
                  ariaLabel="Invitation role"
                  disabled={!canInviteViewer || pending}
                  items={editableRoleItems}
                />
              </Box>
              <Button type="submit" size="sm" flexShrink={0} disabled={!(role === "viewer" ? canInviteViewer : canAddBillable) || pending}>{pending ? <Spinner size="xs" /> : <Mail size={14} />}Send invite</Button>
            </Flex>
            {inviteHint}
            {feedback ? <Text fontSize="12px" color={feedback.ok ? "fg" : "danger.fg"}>{feedback.text}</Text> : null}
            {inviteUrl ? (
              <Flex gap="2"><Input value={inviteUrl} readOnly fontSize="12px" /><Button type="button" variant="subtle" size="sm" onClick={() => navigator.clipboard.writeText(inviteUrl)}><Copy size={14} />Copy</Button></Flex>
            ) : null}
          </Stack>
        </Box>
      </SettingsCard>
      )}

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

      <SettingsCard
        icon={<Users size={16} />}
        title="Members"
        action={<Select ariaLabel="Filter members by role" value={roleFilter} onValueChange={(value) => setRoleFilter(value as Role | "all")} size="sm" w="150px" items={[{ value: "all", label: "All roles" }, { value: "owner", label: "Owners" }, { value: "admin", label: "Admins" }, { value: "editor", label: "Editors" }, { value: "viewer", label: "Viewers" }]} />}
      >
        <Stack gap="1">
          {visibleMembers.length === 0 ? (
            <Text fontSize="13px" color="fg.muted" py="2">No members with this role.</Text>
          ) : null}
          {visibleMembers.map((member) => {
            const name = [member.user.firstName, member.user.lastName].filter(Boolean).join(" ") || member.user.primaryEmail || "Member";
            return (
              <Flex key={member.id} align="center" gap="3" py="2.5" px="2" mx="-2" borderRadius="l2" transition="background 120ms ease" _hover={{ bg: "bg.soft" }}>
                <MemberAvatar label={initials(member.user.firstName, member.user.lastName, member.user.primaryEmail)} />
                <Box flex="1" minW="0">
                  <Text fontSize="14px" fontWeight="500" truncate>{name}</Text>
                  <Text fontSize="12px" color="fg.subtle" truncate>
                    {member.user.primaryEmail}
                    {member.joinedAt ? ` · Joined ${JOINED_FORMAT.format(new Date(member.joinedAt))}` : ""}
                  </Text>
                </Box>
                {member.role === "owner" || !canManageMembers || (actorRole === "admin" && member.role === "admin") ? (
                  <RolePill role={member.role} />
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
                    color="fg.muted"
                    _hover={{ color: "danger.fg", bg: "bg.soft" }}
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
      </SettingsCard>

      {invites.length > 0 ? (
        <SettingsCard icon={<Clock size={16} />} title="Pending invitations">
          <Stack gap="1">
            {invites.map((invite) => {
              const expired = new Date(invite.expiresAt) <= new Date();
              return (
                <Flex key={invite.id} align="center" gap="3" py="2.5" px="2" mx="-2" borderRadius="l2" transition="background 120ms ease" _hover={{ bg: "bg.soft" }}>
                  <MemberAvatar icon={<Mail size={15} />} />
                  <Box flex="1" minW="0">
                    <Text fontSize="14px" fontWeight="500" truncate>{invite.email}</Text>
                    <Text fontSize="12px" color={expired ? "danger.fg" : "fg.subtle"}>{expired ? "Expired" : `Expires ${formatDate(invite.expiresAt)}`}</Text>
                  </Box>
                  <RolePill role={invite.role} />
                  {canManageMembers ? <Button size="sm" variant="ghost" onClick={() => resend(invite.id)} disabled={pending}><Mail size={14} />Resend</Button> : null}
                  {canManageMembers ? <Button size="sm" variant="ghost" aria-label={`Revoke invitation for ${invite.email}`} onClick={() => revoke(invite.id)} disabled={pending}><X size={14} /></Button> : null}
                </Flex>
              );
            })}
          </Stack>
        </SettingsCard>
      ) : null}
    </Stack>
  );
}
