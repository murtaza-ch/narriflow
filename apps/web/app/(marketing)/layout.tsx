import Link from "next/link";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";
import { MarketingMobileNav } from "./_components/marketing-mobile-nav";
import { HeaderAccountActions } from "./_components/account-actions";

const NAV_LINKS = [{ label: "Pricing", href: "/pricing" }];

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box minH="100vh" bg="bg" color="fg">
      <Box as="header" borderBottomWidth="1px" borderColor="border">
        <Flex mx="auto" w="full" maxW="1200px" minH="16" px="6" align="center" justify="space-between" gap="4">
          <Link href="/" aria-label="Narriflow home">
            <Text fontSize="xl" fontWeight="semibold">Narriflow</Text>
          </Link>
          <HStack gap="6">
            <HStack as="nav" aria-label="Main navigation" gap="6" display={{ base: "none", md: "flex" }}>
              {NAV_LINKS.map((item) => (
                <Link key={item.href} href={item.href}>
                  <Text as="span" fontSize="sm" color="fg.muted">{item.label}</Text>
                </Link>
              ))}
            </HStack>
            <HStack display={{ base: "none", md: "flex" }}>
              <HeaderAccountActions />
            </HStack>
            <MarketingMobileNav links={NAV_LINKS} />
          </HStack>
        </Flex>
      </Box>
      {children}
    </Box>
  );
}
