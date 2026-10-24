"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, Drawer, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft, Bell, Braces, Building2, ChartNoAxesCombined, CreditCard, Menu, Share2, ShieldCheck, UserRound, Users, X } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { NavLink } from "@narriflow/ui/components/nav-link";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { ShellHeader, ShellPanel } from "./shell-panel";

const accountLinks = [
  { label: "Profile", href: "/settings/profile", icon: UserRound },
  { label: "Notifications", href: "/settings/notifications", icon: Bell },
];
const workspaceLinks = [
  { label: "Workspace settings", href: "/settings/workspace", icon: Building2 },
  { label: "Members", href: "/settings/members", icon: Users },
  { label: "Social accounts", href: "/settings/social-accounts", icon: Share2 },
  { label: "Automation grants", href: "/settings/automation-grants", icon: ShieldCheck },
  { label: "Billing", href: "/settings/billing", icon: CreditCard },
  { label: "Usage history", href: "/settings/usage", icon: ChartNoAxesCombined },
  { label: "Developer access", href: "/settings/api", icon: Braces },
];

export function SettingsChrome({ workspaceName, canManageApi, backHref, account, themeToggle, children }: {
  workspaceName: string; canManageApi: boolean; backHref: string;
  account: ReactNode; themeToggle: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const section = [...accountLinks, ...workspaceLinks].find((link) => pathname.startsWith(link.href))?.label;
  const navigation = (
    <Stack as="nav" aria-label="Settings sections" gap="6" px="3" py="5" onClick={(event) => {
      if ((event.target as HTMLElement).closest("a")) setOpen(false);
    }}>
      {[{ id: "account", label: "Your account", links: accountLinks }, { id: "workspace", label: workspaceName, links: workspaceLinks.filter((link) => canManageApi || link.href !== "/settings/api") }].map((group) => (
        <Stack gap="1" key={group.id}>
          <Text textStyle="eyebrow" color="fg.muted" px="3" mb="2" overflowWrap="anywhere">{group.label}</Text>
          {group.links.map(({ label, href, icon: Icon }) => <NavLink key={href} href={href} icon={<Icon size={16} />}>{label}</NavLink>)}
        </Stack>
      ))}
    </Stack>
  );
  const back = <Button asChild variant="ghost" size="sm"><Link href={backHref}><ArrowLeft size={15} />Back</Link></Button>;
  return (
    <Flex minH="100dvh">
      {/* Sidebar on the frame; content in the inset panel, as in the main shell */}
      <Box as="aside" position="fixed" insetBlock="0" left="0" w="256px" bg="bg.sidebar" overflowY="auto" display={{ base: "none", lg: "block" }}>
        <Flex h="80px" align="center" px="6"><Link href="/home" aria-label="Narriflow home"><Logo size="md" /></Link></Flex>
        <Box px="3">{back}</Box>
        {navigation}
      </Box>
      <Flex direction="column" flex="1" minW="0" minH="100dvh" ms={{ base: "0", lg: "256px" }} p={{ base: "0", lg: "2" }}>
        <ShellPanel>
          <ShellHeader
            crumbs={section ? ["Settings", section] : ["Settings"]}
            start={
              <Flex gap="1" align="center" display={{ base: "flex", lg: "none" }}>
                <Drawer.Root open={open} onOpenChange={(details) => setOpen(details.open)} placement="start">
                  <Drawer.Trigger asChild><IconButton size="sm" variant="ghost" aria-label="Open settings menu"><Menu size={19} /></IconButton></Drawer.Trigger>
                  <Portal><Drawer.Backdrop /><Drawer.Positioner><Drawer.Content maxW="300px" bg="bg.sidebar">
                    <Drawer.Header><Drawer.Title fontSize="18px" fontWeight="500">Settings</Drawer.Title></Drawer.Header>
                    <Drawer.CloseTrigger asChild><IconButton variant="ghost" size="sm" borderRadius="full" aria-label="Close settings menu"><X size={18} /></IconButton></Drawer.CloseTrigger>
                    <Drawer.Body p="0">{navigation}</Drawer.Body>
                  </Drawer.Content></Drawer.Positioner></Portal>
                </Drawer.Root>
                {back}
              </Flex>
            }
          >
            {themeToggle}
            {account}
          </ShellHeader>
          <Box as="main" css={{ "&:has([data-page-error])": { maxWidth: "none", paddingBlock: "0", "& [data-page-error]": { minHeight: "calc(100dvh - 64px)" } } }} w="full" maxW="1120px" px={{ base: "4", lg: "8" }} pt="6" pb="12">{children}</Box>
        </ShellPanel>
      </Flex>
    </Flex>
  );
}
