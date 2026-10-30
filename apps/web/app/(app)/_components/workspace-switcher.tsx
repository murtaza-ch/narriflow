"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { cancelBusinessWorkspaceCheckout, resumeBusinessWorkspaceCheckout } from "@narriflow/api-client/billing";
import { invalidateSessionBootstrap } from "@narriflow/api-client/session";
import { isApiError, invalidateScoped } from "@narriflow/api-client";
import { Button } from "@narriflow/ui/components/button";
import { useApiRuntime, useIdentityScope } from "@/app/_components/api-provider";
import { checkoutReturnWorkspace, rememberCheckoutWorkspace } from "@/lib/pending-workspace-checkout";
import { Box, Flex, Image, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import { Building2, Check, ChevronDown, Plus, Settings, Users, Share2, Braces, Gem } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { PLAN_CATALOG, resolvePricingTier } from "@narriflow/validators";
import { apiErrorMessage } from "@/app/_components/query-mutation-form";
import { useWorkspaceSwitch } from "@/app/_components/workspace-query-gate";

export interface WorkspaceMenuPresentation {
  tier: string;
  canManageApi: boolean;
  canInvite: boolean;
  planAction: string | null;
}

export interface WorkspaceSwitcherItem {
  id: string;
  name: string;
  role: "owner" | "admin" | "editor" | "viewer";
  isPersonal: boolean;
  avatarUrl: string | null;
  status: "active" | "pending_payment" | "restricted";
}

export function WorkspaceSwitcher({
  activeWorkspaceId,
  items,
  presentation,
}: {
  activeWorkspaceId: string;
  items: WorkspaceSwitcherItem[];
  presentation: WorkspaceMenuPresentation;
}) {
  const runtime = useApiRuntime();
  const { switchTo, pending: isPending, pendingId: switchingTo, error } = useWorkspaceSwitch();
  const switchError = error ? apiErrorMessage(error, "The Workspace could not be selected.") : null;
  const active = items.find((item) => item.id === activeWorkspaceId) ?? items[0];

  function selectWorkspace(workspaceId: string) {
    if (workspaceId === activeWorkspaceId || isPending) return;
    if (items.find((item) => item.id === workspaceId)?.status === "pending_payment") {
      const userId = runtime.scope.snapshot().userId;
      if (userId) rememberCheckoutWorkspace(userId, workspaceId, activeWorkspaceId);
    }
    void switchTo(workspaceId);
  }

  return (
    <Menu.Root positioning={{ placement: "bottom-start", gutter: 6 }}>
      <Box px="3">
        <Menu.Trigger asChild>
          <Flex
            as="button"
            aria-label="Switch workspace"
            w="full"
            align="center"
            gap="2.5"
            px="2.5"
            py="2.5"
            borderRadius="l2"
            textAlign="left"
            cursor="pointer"
            _hover={{ bg: "bg.soft" }}
          >
            <Flex
              w="8"
              h="8"
              align="center"
              justify="center"
              borderRadius="l2"
              bg="bg.soft"
              color="fg.muted"
              flexShrink={0}
              overflow="hidden"
            >
              {active?.avatarUrl ? <Image src={active.avatarUrl} alt="" w="full" h="full" objectFit="cover" /> : <Building2 size={15} />}
            </Flex>
            <Stack gap="0" minW="0" flex="1">
              <Text fontSize="14px" fontWeight="500" truncate>
                {active?.name ?? "Workspace"}
              </Text>
              {/* Neutral on purpose: gold means "plan required", not "plan you have". */}
              <Text fontSize="12px" color="fg.subtle" truncate>
                <Text as="span" textTransform="capitalize">{active?.role ?? "member"}</Text>
                {" · "}
                {active?.status === "pending_payment" ? "Payment pending" : PLAN_CATALOG[resolvePricingTier(presentation.tier)].name}
              </Text>
            </Stack>
            {isPending ? <Spinner size="xs" /> : <ChevronDown size={14} />}
          </Flex>
        </Menu.Trigger>
        {active?.status === "pending_payment" ? <PendingWorkspaceControls workspace={active} items={items} activeWorkspaceId={activeWorkspaceId} /> : null}
      </Box>
      <Portal>
        <Menu.Positioner>
          <Menu.Content w="320px" maxW="calc(100vw - 24px)" p="2" maxH="calc(100dvh - 100px)" overflowY="auto">
            {switchError ? (
              <Text role="alert" px="3" py="2" fontSize="xs" color="danger.fg">
                {switchError}
              </Text>
            ) : null}
            <Stack align="center" textAlign="center" gap="2" px="4" py="5">
              <Flex boxSize="14" align="center" justify="center" borderRadius="l2" bg="bg.soft" color="fg.muted" overflow="hidden">
                {active?.avatarUrl ? <Image src={active.avatarUrl} alt="" boxSize="full" objectFit="cover" /> : <Building2 size={26} />}
              </Flex>
              <Text fontSize="16px" fontWeight="500" overflowWrap="anywhere">{active?.name ?? "Workspace"}</Text>
              <Text fontSize="12px" color="fg.muted" textTransform="capitalize">{presentation.tier} · {active?.role ?? "Member"}</Text>
            </Stack>
            {presentation.planAction ? <Menu.Item value="plan" asChild bg="bg.soft" mb="2">
              <Link href="/settings/billing"><Gem size={16} />{presentation.planAction}</Link>
            </Menu.Item> : null}
            <Menu.Item value="members" asChild>
              <Link href="/settings/members"><Users size={16} />{presentation.canInvite ? "Invite members" : "Members"}</Link>
            </Menu.Item>
            <Menu.Item value="workspace-settings" asChild>
              <Link href="/settings/workspace"><Settings size={16} />Workspace settings</Link>
            </Menu.Item>
            <Menu.Item value="social-accounts" asChild>
              <Link href="/settings/social-accounts"><Share2 size={16} />Social accounts</Link>
            </Menu.Item>
            {presentation.canManageApi ? <Menu.Item value="developer-access" asChild>
              <Link href="/settings/api"><Braces size={16} />Developer access</Link>
            </Menu.Item> : null}
            <Menu.Separator />
            <Box px="3" py="2">
              <Text textStyle="eyebrow" color="fg.muted">Workspaces</Text>
            </Box>
            {items.map((item) => (
              <Box key={item.id}>
              <Menu.Item
                key={item.id}
                value={item.id}
                closeOnSelect={false}
                onClick={() => selectWorkspace(item.id)}
                disabled={isPending}
              >
                <Flex w="6" h="6" align="center" justify="center" borderRadius="l1" bg="bg.soft" color="fg.muted" overflow="hidden">
                  {switchingTo === item.id ? <Spinner size="xs" /> : item.avatarUrl ? <Image src={item.avatarUrl} alt="" w="full" h="full" objectFit="cover" /> : <Building2 size={13} />}
                </Flex>
                <Stack gap="0" minW="0" flex="1">
                  <Text fontSize="13px" truncate>{item.name}</Text>
                  <Text fontSize="12px" color="fg.subtle" textTransform="capitalize">
                    {item.status === "pending_payment" ? "Payment pending" : item.isPersonal ? "Personal" : item.role}
                  </Text>
                </Stack>
                {item.id === activeWorkspaceId ? <Box color="accent.fg" display="flex"><Check size={14} /></Box> : null}
              </Menu.Item>
              {item.status === "pending_payment" && item.id !== activeWorkspaceId ? <PendingWorkspaceControls workspace={item} items={items} activeWorkspaceId={activeWorkspaceId} inMenu /> : null}
              </Box>
            ))}
            <Menu.Separator />
            <Menu.Item value="new-workspace" asChild>
              <Link href="/workspaces/new"><Plus size={14} />New Business workspace</Link>
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

/** Quiet, contextual recovery. No requests run until the owner chooses an action. */
export function PendingWorkspaceControls({ workspace, items, activeWorkspaceId, inMenu = false }: {
  workspace: WorkspaceSwitcherItem; items: WorkspaceSwitcherItem[]; activeWorkspaceId: string; inMenu?: boolean;
}) {
  const runtime = useApiRuntime();
  const identity = useIdentityScope();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const { switchTo } = useWorkspaceSwitch();
  const action = useMutation({
    mutationFn: async (kind: "resume" | "cancel") => {
      if (!identity) return;
      if (kind === "resume") {
        const url = await resumeBusinessWorkspaceCheckout(runtime.transport, identity, workspace.id);
        rememberCheckoutWorkspace(identity.userId, workspace.id, activeWorkspaceId);
        runtime.selectWorkspace(workspace.id);
        window.location.assign(url);
        return;
      }
      await cancelBusinessWorkspaceCheckout(runtime.transport, identity, workspace.id);
      const destination = checkoutReturnWorkspace(identity.userId, workspace.id, items);
      // Adopt the return selection before refetching memberships, so the gate
      // never requests a bootstrap under the removed Workspace hint.
      if (activeWorkspaceId === workspace.id && destination) {
        if (!await switchTo(destination)) throw new Error("Workspace selection failed");
      }
      await Promise.all([
        invalidateSessionBootstrap(runtime.queryClient, identity),
        ...items.filter((item) => item.id !== workspace.id).map((item) =>
          invalidateScoped(runtime.queryClient, { userId: identity.userId, workspaceId: item.id }, "workspace")),
      ]);
    },
  });
  if (workspace.role !== "owner" || workspace.status !== "pending_payment") return null;
  const needsBilling = isApiError(action.error) && action.error.code === "workspace_checkout_state_invalid";
  function control(value: string, label: string, onSelect: () => void) {
    return inMenu ? (
      <Menu.Item value={`${workspace.id}-${value}`} closeOnSelect={false} disabled={action.isPending} onSelect={onSelect}>{label}</Menu.Item>
    ) : (
      <Button size="xs" variant="ghost" disabled={action.isPending} onClick={onSelect}>{label}</Button>
    );
  }
  async function openBilling() {
    if (activeWorkspaceId !== workspace.id && !await switchTo(workspace.id)) return;
    router.push("/settings/billing");
  }
  return <Stack gap="1" px="2.5" pb="2">
    {confirming && !needsBilling ? <Text fontSize="xs" color="fg.muted">Discard {workspace.name} and close its unpaid checkout?</Text> : null}
    <Flex gap="2" flexWrap="wrap" flexDirection={inMenu ? "column" : "row"}>
      {needsBilling ? control("billing", "Open billing", () => { void openBilling(); }) : confirming ? <>
        {control("discard", "Confirm discard", () => action.mutate("cancel"))}
        {control("keep", "Keep workspace", () => setConfirming(false))}
      </> : <>
        {control("resume", "Resume checkout", () => action.mutate("resume"))}
        {control("discard", "Discard workspace", () => setConfirming(true))}
      </>}
    </Flex>
    {action.error ? <Text role="alert" fontSize="xs" color="fg.muted">{apiErrorMessage(action.error, "Checkout could not be updated. Try again.")}</Text> : null}
  </Stack>;
}
