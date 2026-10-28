"use client";

import { UpgradeHero } from "../../_components/upgrade";
import { TeamVisual } from "../../_components/upgrade-visuals";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Clock, Copy, Mail, Trash2, UserPlus, Users, X } from "lucide-react";
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
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

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
      !window.confirm(`This role adds a paid seat (${formatUsdCents(BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS.monthly)}/month or ${formatUsdCents(BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS.annual)}/year). Continue?`)
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
            {feedback ? <Text fontSize="12px" color={inviteUrl ? "fg" : "danger.fg"}>{feedback}</Text> : null}
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
