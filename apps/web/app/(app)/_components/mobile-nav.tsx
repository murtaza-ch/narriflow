"use client";

import { useState } from "react";
import Link from "next/link";
import { Box, Flex, Stack } from "@chakra-ui/react";
import { Menu, X, LayoutDashboard, FolderOpen, Upload, Settings, Sun, Moon } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { NavLink } from "@narriflow/ui/components/nav-link";
import { useColorMode } from "@narriflow/ui/components/color-mode";
import { Text } from "@chakra-ui/react";

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const { colorMode, toggleColorMode } = useColorMode();

  return (
    <Box display={{ base: "block", lg: "none" }}>
      {/* Mobile header */}
      <Flex
        h="52px"
        align="center"
        justify="space-between"
        px="16px"
        borderBottomWidth="1px"
        borderColor="border"
        bg="bg"
        position="fixed"
        top="0"
        left="0"
        right="0"
        zIndex="40"
      >
        <Link href="/dashboard">
          <Logo size="sm" />
        </Link>
        <Flex
          as="button"
          onClick={() => setOpen(!open)}
          align="center"
          justify="center"
          w="32px"
          h="32px"
          borderRadius="8px"
          color="fg.muted"
          cursor="pointer"
          _hover={{ bg: "bg.subtle" }}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </Flex>
      </Flex>

      {/* Overlay */}
      {open && (
        <Box
          position="fixed"
          inset="0"
          top="52px"
          bg="bg"
          zIndex="39"
          overflow="auto"
        >
          <Stack px="8px" py="8px" gap="2" onClick={() => setOpen(false)}>
            <NavLink href="/dashboard" icon={<LayoutDashboard size={18} />}>
              Dashboard
            </NavLink>
            <NavLink href="/projects" icon={<FolderOpen size={18} />}>
              Projects
            </NavLink>
            <NavLink href="/upload" icon={<Upload size={18} />}>
              Upload
            </NavLink>
            <NavLink href="/settings" icon={<Settings size={18} />}>
              Settings
            </NavLink>
            <Flex
              as="button"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                toggleColorMode();
              }}
              align="center"
              gap="8px"
              px="12px"
              py="8px"
              borderRadius="8px"
              fontSize="13px"
              color="fg.muted"
              fontWeight="400"
              cursor="pointer"
              _hover={{ bg: "bg.subtle", color: "fg" }}
            >
              {colorMode === "light" ? <Moon size={18} /> : <Sun size={18} />}
              <Text>{colorMode === "light" ? "Dark mode" : "Light mode"}</Text>
            </Flex>
          </Stack>
        </Box>
      )}
    </Box>
  );
}
