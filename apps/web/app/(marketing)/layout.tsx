import Link from "next/link";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box minH="100vh" bg="bg" color="fg">
      <Box as="header" borderBottomWidth="1px" borderColor="border">
        <Flex mx="auto" w="full" maxW="6xl" align="center" justify="space-between" px="6" py="4">
          <Link href="/">
            <Text textStyle="sm" fontWeight="semibold" letterSpacing="tight">Narriflow</Text>
          </Link>
          <HStack as="nav" gap="4" textStyle="sm" color="fg.muted">
            <Link href="/pricing">Pricing</Link>
            <Link href="/dashboard">App</Link>
          </HStack>
        </Flex>
      </Box>
      {children}
    </Box>
  );
}
