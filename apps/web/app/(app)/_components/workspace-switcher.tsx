"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Image, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import { Building2, Check, ChevronDown, Plus, Settings, Users } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { switchWorkspaceAction } from "../_actions/workspace";
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

export interface WorkspaceSwitcherItem {
  id: string;
  name: string;
  role: "owner" | "admin" | "editor" | "viewer";
  isPersonal: boolean;
  avatarUrl: string | null;
}

export function WorkspaceSwitcher({
  activeWorkspaceId,
  items,
  canCreateWorkspace = false,
}: {
  activeWorkspaceId: string;
  items: WorkspaceSwitcherItem[];
  canCreateWorkspace?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const active = items.find((item) => item.id === activeWorkspaceId) ?? items[0];

  function selectWorkspace(workspaceId: string) {
    if (workspaceId === activeWorkspaceId || isPending) return;
    setSwitchingTo(workspaceId);
    startTransition(async () => {
      setSwitchError(null);
      const result = await switchWorkspaceAction(workspaceId);
      if (isAuthenticatedActionFailure(result)) {
        setSwitchError(
          authenticatedActionResultMessage(
            result,
            "The Workspace could not be selected.",
          ),
        );
        setSwitchingTo(null);
        return;
      }
      router.refresh();
      setSwitchingTo(null);
    });
  }

  return (
    <Menu.Root positioning={{ placement: "bottom-start", gutter: 6 }}>
      <Menu.Trigger asChild>
        <Flex
          as="button"
          aria-label="Switch workspace"
          w="full"
          align="center"
          gap="2.5"
          px="3"
          py="2.5"
          borderRadius="l2"
          textAlign="left"
          cursor="pointer"
          _hover={{ bg: "bg.subtle" }}
        >
          <Flex
            w="8"
            h="8"
            align="center"
            justify="center"
            borderRadius="l2"
            bg="bg.muted"
            color="fg.muted"
            flexShrink={0}
            overflow="hidden"
          >
            {active?.avatarUrl ? <Image src={active.avatarUrl} alt="" w="full" h="full" objectFit="cover" /> : <Building2 size={15} />}
          </Flex>
          <Stack gap="0" minW="0" flex="1">
            <Text fontSize="13px" fontWeight="600" truncate>
              {active?.name ?? "Workspace"}
            </Text>
            <Text fontSize="11px" color="fg.subtle" textTransform="capitalize">
              {active?.role ?? "member"}
            </Text>
          </Stack>
          {isPending ? <Spinner size="xs" /> : <ChevronDown size={14} />}
        </Flex>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="260px" p="1">
            {switchError ? (
              <Text role="alert" px="3" py="2" fontSize="xs" color="danger.fg">
                {switchError}
              </Text>
            ) : null}
            <Box px="3" py="2">
              <Text textStyle="eyebrow" color="fg.subtle">Workspaces</Text>
            </Box>
            {items.map((item) => (
              <Menu.Item
                key={item.id}
                value={item.id}
                gap="2.5"
                borderRadius="l1"
                onClick={() => selectWorkspace(item.id)}
                disabled={isPending}
              >
                <Flex w="6" h="6" align="center" justify="center" borderRadius="l1" bg="bg.muted">
                  {switchingTo === item.id ? <Spinner size="xs" /> : item.avatarUrl ? <Image src={item.avatarUrl} alt="" w="full" h="full" objectFit="cover" /> : <Building2 size={13} />}
                </Flex>
                <Stack gap="0" minW="0" flex="1">
                  <Text fontSize="13px" truncate>{item.name}</Text>
                  <Text fontSize="11px" color="fg.subtle" textTransform="capitalize">
                    {item.isPersonal ? "Personal" : item.role}
                  </Text>
                </Stack>
                {item.id === activeWorkspaceId ? <Check size={14} /> : null}
              </Menu.Item>
            ))}
            <Menu.Separator />
            {canCreateWorkspace ? (
              <Menu.Item value="new-workspace" asChild gap="2" borderRadius="l1">
                <Link href="/workspaces/new"><Plus size={14} />New Business workspace</Link>
              </Menu.Item>
            ) : null}
            <Menu.Item value="workspace-settings" asChild gap="2" borderRadius="l1">
              <Link href="/settings/workspace"><Settings size={14} />Workspace settings</Link>
            </Menu.Item>
            <Menu.Item value="members" asChild gap="2" borderRadius="l1">
              <Link href="/settings/members"><Users size={14} />Members</Link>
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
