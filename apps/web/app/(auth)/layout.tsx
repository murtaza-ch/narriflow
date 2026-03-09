import Link from "next/link";
import { Flex, Stack, Box } from "@chakra-ui/react";
import { Logo } from "@narriflow/ui/components/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Flex
      as="main"
      minH="100vh"
      align="center"
      justify="center"
      bg="bg"
      px="6"
      py="10"
      color="fg"
      position="relative"
    >
      {/* Subtle background accent glow */}
      <Box
        position="absolute"
        top="50%"
        left="50%"
        transform="translate(-50%, -50%)"
        w="600px"
        h="600px"
        borderRadius="full"
        bg="accent.subtle"
        opacity="0.3"
        filter="blur(120px)"
        pointerEvents="none"
      />

      <Stack gap="6" align="center" position="relative">
        <Link href="/">
          <Logo size="lg" />
        </Link>
        <Stack
          w="full"
          maxW="400px"
          gap="6"
          borderRadius="16px"
          borderWidth="1px"
          borderColor="border"
          bg="bg.panel"
          p="32px"
          shadow="md"
        >
          {children}
        </Stack>
      </Stack>
    </Flex>
  );
}
