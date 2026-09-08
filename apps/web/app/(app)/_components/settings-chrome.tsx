"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Box, Drawer, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft, Bell, Braces, Building2, ChartNoAxesCombined, CreditCard, Menu, Share2, UserRound, Users, X } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { NavLink } from "@narriflow/ui/components/nav-link";
import { Button, IconButton } from "@narriflow/ui/components/button";

const accountLinks = [
  { label: "Profile", href: "/settings/profile", icon: UserRound },
  { label: "Notifications", href: "/settings/notifications", icon: Bell },
];
const workspaceLinks = [
  { label: "Workspace settings", href: "/settings/workspace", icon: Building2 },
  { label: "Members", href: "/settings/members", icon: Users },
  { label: "Social accounts", href: "/settings/social-accounts", icon: Share2 },
  { label: "Billing", href: "/settings/billing", icon: CreditCard },
  { label: "Usage history", href: "/settings/usage", icon: ChartNoAxesCombined },
  { label: "Developer access", href: "/settings/api", icon: Braces },
];

export function SettingsChrome({ workspaceName, canManageApi, backHref, account, themeToggle, children }: {
  workspaceName: string; canManageApi: boolean; backHref: string;
  account: ReactNode; themeToggle: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const navigation = (
    <Stack as="nav" aria-label="Settings sections" gap="6" px="3" py="5" onClick={(event) => {
      if ((event.target as HTMLElement).closest("a")) setOpen(false);
    }}>
      {[{ id: "account", label: "Your account", links: accountLinks }, { id: "workspace", label: workspaceName, links: workspaceLinks.filter((link) => canManageApi || link.href !== "/settings/api") }].map((group) => (
        <Stack gap="1" key={group.id}>
          <Text fontSize="12px" color="fg.subtle" px="3" mb="2" overflowWrap="anywhere">{group.label}</Text>
          {group.links.map(({ label, href, icon: Icon }) => <NavLink key={href} href={href} icon={<Icon size={16} />}>{label}</NavLink>)}
        </Stack>
      ))}
    </Stack>
  );
  const back = <Button asChild variant="ghost" size="sm"><Link href={backHref}><ArrowLeft size={15} />Back</Link></Button>;
  return (
    <Flex minH="100dvh">
      <Box as="aside" position="fixed" insetBlock="0" left="0" w="232px" bg="bg.sidebar" borderRightWidth="1px" borderColor="border.subtle" overflowY="auto" display={{ base: "none", lg: "block" }}>
        <Flex h="72px" align="center" px="6"><Link href="/home" aria-label="Narriflow home"><Logo size="md" /></Link></Flex>
        <Box px="3">{back}</Box>
        {navigation}
      </Box>
      <Box flex="1" minW="0" ml={{ base: "0", lg: "232px" }}>
        <Flex as="header" h="64px" px={{ base: "4", lg: "8" }} align="center" justify="space-between">
          <Flex gap="1" align="center" display={{ base: "flex", lg: "none" }}>
            <Drawer.Root open={open} onOpenChange={(details) => setOpen(details.open)} placement="start">
              <Drawer.Trigger asChild><IconButton size="sm" variant="ghost" aria-label="Open settings menu"><Menu size={19} /></IconButton></Drawer.Trigger>
              <Portal><Drawer.Backdrop /><Drawer.Positioner><Drawer.Content maxW="300px" bg="bg.sidebar">
                <Drawer.Header><Drawer.Title>Settings</Drawer.Title></Drawer.Header>
                <Drawer.CloseTrigger asChild><IconButton variant="ghost" size="sm" aria-label="Close settings menu"><X size={18} /></IconButton></Drawer.CloseTrigger>
                <Drawer.Body p="0">{navigation}</Drawer.Body>
              </Drawer.Content></Drawer.Positioner></Portal>
            </Drawer.Root>
            {back}
          </Flex>
          <Flex ml="auto" gap="2" align="center">{themeToggle}{account}</Flex>
        </Flex>
        <Box as="main" w="full" maxW="1120px" px={{ base: "4", lg: "8" }} pt="6" pb="12">{children}</Box>
      </Box>
    </Flex>
  );
}
