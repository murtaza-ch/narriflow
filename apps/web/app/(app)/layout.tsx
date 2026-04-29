import { redirect } from "next/navigation";
import { getCurrentAppUser } from "@narriflow/auth";
import { Box, Flex } from "@chakra-ui/react";
import { Sidebar } from "./_components/sidebar";
import { MobileNav } from "./_components/mobile-nav";
import { AccountMenu } from "./_components/account-menu";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    redirect("/sign-in");
  }

  if (!appUser.onboardingCompletedAt) {
    redirect("/onboarding");
  }

  return (
    <Box minH="100vh" bg="bg" color="fg">
      {/* Desktop sidebar */}
      <Sidebar
        email={appUser.primaryEmail}
        firstName={appUser.firstName}
        imageUrl={appUser.imageUrl}
        lastName={appUser.lastName}
      />

      {/* Mobile nav */}
      <MobileNav />

      {/* Main content area */}
      <Box
        ml={{ base: "0", lg: "240px" }}
        pt={{ base: "52px", lg: "0" }}
        minH="100vh"
      >
        {/* Top bar (desktop only) */}
        <Flex
          h="52px"
          align="center"
          justify="flex-end"
          px="24px"
          borderBottomWidth="1px"
          borderColor="border"
          display={{ base: "none", lg: "flex" }}
        >
          <AccountMenu
            email={appUser.primaryEmail}
            firstName={appUser.firstName}
            imageUrl={appUser.imageUrl}
            lastName={appUser.lastName}
          />
        </Flex>

        {/* Page content */}
        <Box as="main" w="full" px={{ base: "16px", md: "32px" }} py="32px">
          {children}
        </Box>
      </Box>
    </Box>
  );
}
