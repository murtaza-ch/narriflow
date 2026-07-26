"use client";

import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Logo } from "@narriflow/ui/components/logo";
import { NavLink } from "@narriflow/ui/components/nav-link";
import { Meter } from "@narriflow/ui/components/meter";
import { NAV_ITEMS } from "./nav-items";
import { AccountMenu } from "./account-menu";
import { usagePalette } from "./usage-palette";

interface SidebarProps {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  usedMinutes: number;
  limitMinutes: number;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text textStyle="eyebrow" color="fg.subtle" px="3" pt="5" pb="1.5" userSelect="none">
      {children}
    </Text>
  );
}

function NavSection({ section }: { section: "studio" | "workspace" }) {
  return (
    <>
      {NAV_ITEMS.filter((item) => item.section === section).map(
        ({ label, href, icon: Icon }) => (
          <NavLink key={href} href={href} icon={<Icon size={16} />}>
            {label}
          </NavLink>
        ),
      )}
    </>
  );
}

export function Sidebar({
  email,
  firstName,
  lastName,
  imageUrl,
  usedMinutes,
  limitMinutes,
}: SidebarProps) {
  const usagePct = limitMinutes > 0 ? Math.min(100, (usedMinutes / limitMinutes) * 100) : 0;
  const palette = usagePalette(usagePct);

  return (
    <Flex
      as="aside"
      w="240px"
      h="100dvh"
      position="fixed"
      top="0"
      left="0"
      display={{ base: "none", lg: "flex" }}
      direction="column"
      borderRightWidth="1px"
      borderColor="border"
      zIndex="30"
    >
      {/* Logo — hairline aligns with the content top bar */}
      <Flex
        h="48px"
        align="center"
        px="5"
        flexShrink={0}
        borderBottomWidth="1px"
        borderColor="border.subtle"
      >
        <Link href="/dashboard" aria-label="Narriflow dashboard">
          <Logo size="md" />
        </Link>
      </Flex>

      {/* Navigation — single IA source */}
      <Stack as="nav" flex="1" px="3" pb="3" gap="0.5" overflowY="auto">
        <SectionLabel>Studio</SectionLabel>
        <NavSection section="studio" />
        <SectionLabel>Workspace</SectionLabel>
        <NavSection section="workspace" />
      </Stack>

      {/* Usage mini-meter + account cluster */}
      <Box px="3" py="3" borderTopWidth="1px" borderColor="border.subtle" flexShrink={0}>
        <Box px="2.5" pt="1" pb="3">
          <Flex align="baseline" justify="space-between" gap="3" mb="1.5">
            <Text textStyle="eyebrow" color="fg.subtle">
              Usage
            </Text>
            <Text
              textStyle="data"
              fontSize="12px"
              color={palette === "accent" ? "fg.muted" : `${palette}.fg`}
            >
              {Math.round(usedMinutes)}/{Math.round(limitMinutes)} min
            </Text>
          </Flex>
          <Meter
            value={usagePct}
            palette={palette}
            showValue={false}
            aria-label="Monthly processing minutes used"
          />
        </Box>
        <AccountMenu
          variant="row"
          email={email}
          firstName={firstName}
          lastName={lastName}
          imageUrl={imageUrl}
        />
      </Box>
    </Flex>
  );
}
