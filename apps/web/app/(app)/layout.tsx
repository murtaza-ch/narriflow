import Link from "next/link";
import { getCurrentAppUser } from "@narriflow/auth";
import { redirect } from "next/navigation";
import { AccountMenu } from "./_components/account-menu";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";

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
      <Box as="header" borderBottomWidth="1px" borderColor="border">
        <Flex mx="auto" w="full" maxW="6xl" align="center" justify="space-between" px="6" py="4">
          <Link href="/dashboard">
            <Text textStyle="sm" fontWeight="semibold" letterSpacing="tight">Narriflow App</Text>
          </Link>
          <HStack gap="4">
            <HStack as="nav" gap="4" textStyle="sm" color="fg.muted">
              <Link href="/dashboard">Dashboard</Link>
              <Link href="/upload">Upload</Link>
              <Link href="/projects">Projects</Link>
              <Link href="/">Marketing</Link>
            </HStack>
            <AccountMenu
              email={appUser.primaryEmail}
              firstName={appUser.firstName}
              imageUrl={appUser.imageUrl}
              lastName={appUser.lastName}
            />
          </HStack>
        </Flex>
      </Box>
      <Box as="main" mx="auto" w="full" maxW="6xl" px="6" py="8">{children}</Box>
    </Box>
  );
}
