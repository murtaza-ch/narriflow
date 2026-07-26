"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useClerk } from "@clerk/nextjs";
import { Box, Drawer, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { LogOut, Menu as MenuIcon, Moon, Sun, X } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { NavLink } from "@narriflow/ui/components/nav-link";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Meter } from "@narriflow/ui/components/meter";
import { useColorMode } from "@narriflow/ui/components/color-mode";
import { NAV_ITEMS } from "./nav-items";
import { AccountAvatar, getDisplayName, getInitials } from "./account-menu";
import { isStudioRoute } from "./theme-toggle";
import { usagePalette } from "./usage-palette";

interface MobileNavProps {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  usedMinutes: number;
  limitMinutes: number;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text textStyle="eyebrow" color="fg.subtle" px="3" pt="4" pb="1.5" userSelect="none">
      {children}
    </Text>
  );
}

export function MobileNav({
  email,
  firstName,
  lastName,
  imageUrl,
  usedMinutes,
  limitMinutes,
}: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const { colorMode, toggleColorMode } = useColorMode();
  const { signOut } = useClerk();
  const pathname = usePathname();

  const displayName = getDisplayName(firstName, lastName);
  const initials = getInitials(firstName, lastName, email);
  const usagePct = limitMinutes > 0 ? Math.min(100, (usedMinutes / limitMinutes) * 100) : 0;
  const palette = usagePalette(usagePct);

  // Close the drawer whenever navigation lands on a new route.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  async function onSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut({ redirectUrl: "/" });
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <Box display={{ base: "block", lg: "none" }}>
      <Drawer.Root
        open={open}
        onOpenChange={(details) => setOpen(details.open)}
        placement="start"
      >
        {/* Mobile top bar */}
        <Flex
          h="48px"
          align="center"
          justify="space-between"
          px="4"
          borderBottomWidth="1px"
          borderColor="border"
          bg="bg/85"
          backdropFilter="blur(12px)"
          position="fixed"
          top="0"
          left="0"
          right="0"
          zIndex="40"
        >
          <Link href="/dashboard" aria-label="Narriflow dashboard">
            <Logo size="sm" />
          </Link>
          <Drawer.Trigger asChild>
            <Flex
              as="button"
              aria-label="Open menu"
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
              <MenuIcon size={20} />
            </Flex>
          </Drawer.Trigger>
        </Flex>

        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content bg="bg" maxW="300px" display="flex" flexDirection="column">
              {/* Drawer header */}
              <Flex
                h="48px"
                align="center"
                justify="space-between"
                px="4"
                borderBottomWidth="1px"
                borderColor="border.subtle"
                flexShrink={0}
              >
                <Logo size="sm" />
                <Drawer.CloseTrigger asChild>
                  <Flex
                    as="button"
                    aria-label="Close menu"
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
                    <X size={18} />
                  </Flex>
                </Drawer.CloseTrigger>
              </Flex>

              {/* Navigation — single IA source */}
              <Stack as="nav" flex="1" px="3" pb="3" gap="0.5" overflowY="auto">
                <SectionLabel>Studio</SectionLabel>
                {NAV_ITEMS.filter((item) => item.section === "studio").map(
                  ({ label, href, icon: Icon }) => (
                    <NavLink key={href} href={href} icon={<Icon size={16} />}>
                      {label}
                    </NavLink>
                  ),
                )}
                <SectionLabel>Workspace</SectionLabel>
                {NAV_ITEMS.filter((item) => item.section === "workspace").map(
                  ({ label, href, icon: Icon }) => (
                    <NavLink key={href} href={href} icon={<Icon size={16} />}>
                      {label}
                    </NavLink>
                  ),
                )}
                {!isStudioRoute(pathname) && (
                  <>
                    <Box h="1px" bg="border.subtle" my="2" />
                    <Flex
                      as="button"
                      onClick={toggleColorMode}
                      align="center"
                      gap="2.5"
                      px="3"
                      py="1.5"
                      borderRadius="l2"
                      fontSize="13px"
                      color="fg.muted"
                      fontWeight="450"
                      cursor="pointer"
                      transition="background 120ms ease, color 120ms ease"
                      _hover={{ bg: "bg.subtle", color: "fg" }}
                    >
                      {colorMode === "light" ? <Moon size={16} /> : <Sun size={16} />}
                      <Text>{colorMode === "light" ? "Dark mode" : "Light mode"}</Text>
                    </Flex>
                  </>
                )}
              </Stack>

              {/* Account block + sign out */}
              <Box px="4" py="4" borderTopWidth="1px" borderColor="border.subtle" flexShrink={0}>
                {/* Compact usage meter — mirrors the sidebar's, mobile has no other home for it */}
                <Box mb="3">
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
                <Flex align="center" gap="2.5" mb="3">
                  <AccountAvatar
                    imageUrl={imageUrl}
                    initials={initials}
                    alt={displayName}
                    size="sm"
                  />
                  <Stack gap="0" minW="0">
                    <Text fontSize="13px" fontWeight="550" color="fg" truncate>
                      {displayName}
                    </Text>
                    <Text fontSize="11px" color="fg.subtle" truncate>
                      {email ?? ""}
                    </Text>
                  </Stack>
                </Flex>
                <Flex
                  as="button"
                  onClick={onSignOut}
                  aria-disabled={isSigningOut}
                  w="full"
                  align="center"
                  justify="center"
                  gap="2"
                  px="3"
                  py="2"
                  borderRadius="l2"
                  borderWidth="1px"
                  borderColor="border.control"
                  fontSize="13px"
                  fontWeight="550"
                  color={isSigningOut ? "fg.disabled" : "fg"}
                  cursor={isSigningOut ? "default" : "pointer"}
                  pointerEvents={isSigningOut ? "none" : "auto"}
                  transition="background 120ms ease, border-color 120ms ease"
                  _hover={{ bg: "bg.subtle" }}
                >
                  {isSigningOut ? <Spinner size="xs" /> : <LogOut size={14} />}
                  <Text>{isSigningOut ? "Signing out…" : "Sign out"}</Text>
                </Flex>
              </Box>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>
    </Box>
  );
}
