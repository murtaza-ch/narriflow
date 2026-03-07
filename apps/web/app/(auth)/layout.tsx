import Link from "next/link";
import { Flex, Stack, Box, Heading, Text } from "@chakra-ui/react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Flex as="main" minH="100vh" align="center" justify="center" bg="bg" px="6" py="10" color="fg">
      <Stack w="full" maxW="md" gap="6" rounded="xl" borderWidth="1px" borderColor="border" bg="bg.panel" p="6" shadow="sm">
        <Stack gap="2" textAlign="center">
          <Link href="/">
            <Text textStyle="sm" fontWeight="semibold" letterSpacing="tight">Narriflow</Text>
          </Link>
          <Heading size="lg" fontWeight="semibold" letterSpacing="tight">Welcome to Narriflow</Heading>
          <Text textStyle="sm" color="fg.muted">
            Sign in or create an account to continue turning long-form content into social-ready assets.
          </Text>
        </Stack>
        {children}
      </Stack>
    </Flex>
  );
}
