import Link from "next/link";
import { Box, Flex, HStack, Text, Stack, SimpleGrid } from "@chakra-ui/react";
import { Logo } from "@narriflow/ui/components/logo";
import { Button } from "@narriflow/ui/components/button";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box minH="100vh" bg="bg" color="fg">
      {/* Header */}
      <Box as="header" borderBottomWidth="1px" borderColor="border.subtle" position="sticky" top="0" zIndex="40" bg="bg">
        <Flex mx="auto" w="full" maxW="1200px" align="center" justify="space-between" px="6" h="56px">
          <Link href="/">
            <Logo size="md" />
          </Link>
          <HStack as="nav" gap="6" display={{ base: "none", md: "flex" }}>
            <Link href="/pricing">
              <Text fontSize="13px" color="fg.muted" fontWeight="400" transition="color 150ms ease" _hover={{ color: "fg" }}>
                Pricing
              </Text>
            </Link>
          </HStack>
          <HStack gap="3">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/sign-in">Sign in</Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/sign-up">Get Started</Link>
            </Button>
          </HStack>
        </Flex>
      </Box>

      {children}

      {/* Footer */}
      <Box as="footer" borderTopWidth="1px" borderColor="border">
        <Box mx="auto" maxW="1200px" px="6" pt="48px" pb="48px">
          <SimpleGrid columns={{ base: 2, md: 4 }} gap="8" mb="12">
            <Stack gap="3">
              <Text fontSize="13px" fontWeight="600" color="fg">Product</Text>
              <Stack gap="2">
                <Link href="/pricing"><Text fontSize="13px" color="fg.muted" transition="color 150ms ease" _hover={{ color: "fg" }}>Pricing</Text></Link>
                <Link href="/dashboard"><Text fontSize="13px" color="fg.muted" transition="color 150ms ease" _hover={{ color: "fg" }}>Dashboard</Text></Link>
              </Stack>
            </Stack>
            <Stack gap="3">
              <Text fontSize="13px" fontWeight="600" color="fg">Resources</Text>
              <Stack gap="2">
                <Link href="/blog"><Text fontSize="13px" color="fg.muted" transition="color 150ms ease" _hover={{ color: "fg" }}>Blog</Text></Link>
              </Stack>
            </Stack>
            <Stack gap="3">
              <Text fontSize="13px" fontWeight="600" color="fg">Company</Text>
              <Stack gap="2">
                <Text fontSize="13px" color="fg.subtle">About</Text>
              </Stack>
            </Stack>
            <Stack gap="3">
              <Text fontSize="13px" fontWeight="600" color="fg">Legal</Text>
              <Stack gap="2">
                <Text fontSize="13px" color="fg.subtle">Privacy</Text>
                <Text fontSize="13px" color="fg.subtle">Terms</Text>
              </Stack>
            </Stack>
          </SimpleGrid>
          <Flex align="center" justify="space-between" borderTopWidth="1px" borderColor="border" pt="6">
            <Logo size="sm" />
            <Text fontSize="12px" color="fg.subtle">&copy; {new Date().getFullYear()} Narriflow. All rights reserved.</Text>
          </Flex>
        </Box>
      </Box>
    </Box>
  );
}
