"use client";

import { usePathname } from "next/navigation";
import { Box, Flex } from "@chakra-ui/react";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";
import { AccountMenu } from "./account-menu";
import { ThemeToggle } from "./theme-toggle";

interface AppChromeProps {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  usedMinutes: number;
  limitMinutes: number;
  children: React.ReactNode;
}

/** Slim top bar (desktop only) — theme toggle + account menu. Present in
 *  both the normal shell and the /upload funnel: it isn't workspace nav
 *  chrome (that's the Sidebar/MobileNav), so there's no reason to hide it
 *  along with those. */
function DesktopTopBar({
  email,
  firstName,
  lastName,
  imageUrl,
}: Pick<AppChromeProps, "email" | "firstName" | "lastName" | "imageUrl">) {
  return (
    <Flex
      h="48px"
      align="center"
      justify="flex-end"
      gap="2"
      px="6"
      borderBottomWidth="1px"
      borderColor="border.subtle"
      display={{ base: "none", lg: "flex" }}
      flexShrink={0}
    >
      <ThemeToggle />
      <AccountMenu email={email} firstName={firstName} imageUrl={imageUrl} lastName={lastName} />
    </Flex>
  );
}

/**
 * Owns the pathname-based split between the normal app shell (fixed
 * sidebar + its 240px content offset + mobile nav bar) and the /upload
 * funnel, which is a focused, Vizard-style flow with no nav chrome — the
 * upload page renders its own back link + usage line in place of the
 * sidebar.
 *
 * This used to be a `usePathname` early-return inside Sidebar itself, which
 * only hid the sidebar's own markup: AppLayout's `ml`/`pt` content offset
 * and the always-mounted MobileNav bar stayed in place regardless, leaving
 * the funnel visibly off-center on desktop with a dead mobile top bar
 * underneath. Pulling the pathname check up into this one client wrapper
 * lets AppLayout stay a server component while every piece (offset, mobile
 * nav, sidebar) reacts to the same route check together.
 */
export function AppChrome({
  email,
  firstName,
  lastName,
  imageUrl,
  usedMinutes,
  limitMinutes,
  children,
}: AppChromeProps) {
  const pathname = usePathname();
  const isUploadFunnel = pathname?.startsWith("/upload") ?? false;
  // An open project is a focused Vizard-style workspace too: no sidebar, the
  // page renders its own back-arrow bar. The /projects LIST keeps the normal
  // shell; the Studio route is a fixed overlay and never sees this chrome.
  const isProjectWorkspace = /^\/projects\/[^/]+/.test(pathname ?? "");

  if (isUploadFunnel || isProjectWorkspace) {
    return (
      <Flex direction="column" minH="100dvh">
        <DesktopTopBar
          email={email}
          firstName={firstName}
          lastName={lastName}
          imageUrl={imageUrl}
        />
        <Box as="main" flex="1" w="full" px={{ base: "4", md: "8" }} py={{ base: "6", md: "8" }}>
          {children}
        </Box>
      </Flex>
    );
  }

  return (
    <>
      {/* Desktop sidebar — separated from content by a single hairline */}
      <Sidebar
        email={email}
        firstName={firstName}
        imageUrl={imageUrl}
        lastName={lastName}
        usedMinutes={usedMinutes}
        limitMinutes={limitMinutes}
      />

      {/* Mobile nav */}
      <MobileNav
        email={email}
        firstName={firstName}
        imageUrl={imageUrl}
        lastName={lastName}
        usedMinutes={usedMinutes}
        limitMinutes={limitMinutes}
      />

      {/* Content region — flat porcelain ground */}
      <Flex
        direction="column"
        ml={{ base: "0", lg: "240px" }}
        pt={{ base: "48px", lg: "0" }}
        minH="100dvh"
      >
        {/* Slim top bar (desktop) — the page below owns its PageHeader */}
        <DesktopTopBar
          email={email}
          firstName={firstName}
          lastName={lastName}
          imageUrl={imageUrl}
        />

        {/* Page content */}
        <Box as="main" flex="1" w="full" px={{ base: "4", md: "8" }} py={{ base: "6", md: "8" }}>
          {children}
        </Box>
      </Flex>
    </>
  );
}
