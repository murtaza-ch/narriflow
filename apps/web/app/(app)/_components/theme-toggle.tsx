"use client";

import { Flex } from "@chakra-ui/react";
import { Sun, Moon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useColorMode } from "@narriflow/ui/components/color-mode";

/**
 * Studio chrome is permanently graphite (mode-invariant), so the theme
 * toggle disappears on studio routes.
 */
export function isStudioRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname.endsWith("/studio") || pathname.includes("/studio/");
}

export function ThemeToggle() {
  const { colorMode, toggleColorMode } = useColorMode();
  const pathname = usePathname();

  if (isStudioRoute(pathname)) return null;

  return (
    <Flex
      as="button"
      onClick={toggleColorMode}
      aria-label={colorMode === "light" ? "Switch to dark mode" : "Switch to light mode"}
      align="center"
      justify="center"
      w="8"
      h="8"
      borderRadius="l2"
      color="fg.muted"
      cursor="pointer"
      transition="background 120ms ease, color 120ms ease"
      _hover={{ bg: "bg.subtle", color: "fg" }}
    >
      {colorMode === "light" ? <Moon size={16} /> : <Sun size={16} />}
    </Flex>
  );
}
