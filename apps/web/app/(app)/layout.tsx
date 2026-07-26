import { redirect } from "next/navigation";
import { getCurrentAppUser } from "@narriflow/auth";
import { Box, Flex } from "@chakra-ui/react";
import { Sidebar } from "./_components/sidebar";
import { MobileNav } from "./_components/mobile-nav";
import { AccountMenu } from "./_components/account-menu";
import { ThemeToggle } from "./_components/theme-toggle";
import { getCachedDashboardStats } from "./_components/usage";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    redirect("/sign-in");
  }

  if (!appUser.onboardingCompletedAt) {
    redirect("/onboarding");
  }

  const stats = await getCachedDashboardStats(appUser.id);

  return (
    <Box minH="100dvh" bg="bg" color="fg">
      {/* Desktop sidebar — separated from content by a single hairline */}
      <Sidebar
        email={appUser.primaryEmail}
        firstName={appUser.firstName}
        imageUrl={appUser.imageUrl}
        lastName={appUser.lastName}
        usedMinutes={stats.usedMinutes}
        limitMinutes={stats.limitMinutes}
      />

      {/* Mobile nav */}
      <MobileNav
        email={appUser.primaryEmail}
        firstName={appUser.firstName}
        imageUrl={appUser.imageUrl}
        lastName={appUser.lastName}
        usedMinutes={stats.usedMinutes}
        limitMinutes={stats.limitMinutes}
      />

      {/* Content region — flat porcelain ground */}
      <Flex
        direction="column"
        ml={{ base: "0", lg: "240px" }}
        pt={{ base: "48px", lg: "0" }}
        minH="100dvh"
      >
        {/* Slim top bar (desktop) — the page below owns its PageHeader */}
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
          <AccountMenu
            email={appUser.primaryEmail}
            firstName={appUser.firstName}
            imageUrl={appUser.imageUrl}
            lastName={appUser.lastName}
          />
        </Flex>

        {/* Page content */}
        <Box as="main" flex="1" w="full" px={{ base: "4", md: "8" }} py={{ base: "6", md: "8" }}>
          {children}
        </Box>
      </Flex>
    </Box>
  );
}
