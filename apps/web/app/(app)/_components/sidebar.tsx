"use client";

import Link from "next/link";
import { Box, Stack, Flex, Text } from "@chakra-ui/react";
import { LayoutDashboard, FolderOpen, Upload, Settings } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { NavLink } from "@narriflow/ui/components/nav-link";
import { useColorMode } from "@narriflow/ui/components/color-mode";
import { Sun, Moon } from "lucide-react";

interface SidebarProps {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
}

export function Sidebar({ email, firstName, lastName }: SidebarProps) {
  const { colorMode, toggleColorMode } = useColorMode();
  const displayName = [firstName, lastName].filter(Boolean).join(" ") || "Account";

  return (
    <Box
      as="aside"
      w="240px"
      h="100vh"
      position="fixed"
      top="0"
      left="0"
      borderRightWidth="1px"
      borderColor="border"
      bg="bg"
      display={{ base: "none", lg: "flex" }}
      flexDirection="column"
      zIndex="30"
    >
      {/* Logo */}
      <Flex h="52px" align="center" px="16px" flexShrink={0}>
        <Link href="/dashboard">
          <Logo size="md" />
        </Link>
      </Flex>

      {/* Navigation */}
      <Stack flex="1" px="8px" pt="8px" gap="2">
        <NavLink href="/dashboard" icon={<LayoutDashboard size={18} />}>
          Dashboard
        </NavLink>
        <NavLink href="/projects" icon={<FolderOpen size={18} />}>
          Projects
        </NavLink>
        <NavLink href="/upload" icon={<Upload size={18} />}>
          Upload
        </NavLink>
      </Stack>

      {/* Bottom section */}
      <Stack px="8px" pb="12px" gap="2" borderTopWidth="1px" borderColor="border" pt="8px">
        <NavLink href="/settings" icon={<Settings size={18} />}>
          Settings
        </NavLink>
        <Flex
          as="button"
          onClick={toggleColorMode}
          align="center"
          gap="8px"
          px="12px"
          py="8px"
          borderRadius="8px"
          fontSize="13px"
          color="fg.muted"
          fontWeight="400"
          cursor="pointer"
          transition="all 150ms ease"
          _hover={{ bg: "bg.subtle", color: "fg" }}
        >
          {colorMode === "light" ? <Moon size={18} /> : <Sun size={18} />}
          <Text>{colorMode === "light" ? "Dark mode" : "Light mode"}</Text>
        </Flex>

        {/* Account info */}
        <Flex
          align="center"
          gap="8px"
          px="12px"
          py="8px"
          borderTopWidth="1px"
          borderColor="border"
          mt="4px"
          pt="12px"
        >
          <Box
            w="28px"
            h="28px"
            borderRadius="full"
            bg="accent.subtle"
            display="flex"
            alignItems="center"
            justifyContent="center"
            fontSize="11px"
            fontWeight="600"
            color="fg.accent"
            flexShrink={0}
          >
            {(firstName?.charAt(0) ?? email?.charAt(0) ?? "U").toUpperCase()}
          </Box>
          <Stack gap="0" overflow="hidden">
            <Text fontSize="13px" fontWeight="500" color="fg" truncate>
              {displayName}
            </Text>
            <Text fontSize="11px" color="fg.subtle" truncate>
              {email ?? ""}
            </Text>
          </Stack>
        </Flex>
      </Stack>
    </Box>
  );
}
