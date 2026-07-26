import Link from "next/link";
import { Box, Flex, HStack, Text, Stack, SimpleGrid } from "@chakra-ui/react";
import { Logo } from "@narriflow/ui/components/logo";
import { Button } from "@narriflow/ui/components/button";
import { MarketingMobileNav } from "./_components/marketing-mobile-nav";

const NAV_LINKS = [
  { label: "Features", href: "/#features" },
  { label: "How it works", href: "/#pipeline" },
  { label: "Pricing", href: "/pricing" },
];

const FOOTER_COLUMNS: {
  heading: string;
  items: { label: string; href: string }[];
}[] = [
  {
    heading: "Product",
    items: [
      { label: "Features", href: "/#features" },
      { label: "How it works", href: "/#pipeline" },
      { label: "Pricing", href: "/pricing" },
      { label: "Dashboard", href: "/dashboard" },
    ],
  },
  {
    heading: "Legal",
    items: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

function FooterLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href}>
      <Text
        as="span"
        fontSize="13px"
        color="fg.muted"
        textDecoration="underline"
        textUnderlineOffset="3px"
        textDecorationColor="border.emphasized"
        transition="color 120ms ease, text-decoration-color 120ms ease"
        _hover={{ color: "fg", textDecorationColor: "fg" }}
      >
        {label}
      </Text>
    </Link>
  );
}

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box minH="100vh" bg="bg" color="fg">
      {/* Header — flat porcelain bar separated by a hairline, not a floating pill */}
      <Box
        as="header"
        position="sticky"
        top="0"
        zIndex="50"
        borderBottomWidth="1px"
        borderColor="border"
        bg="bg/85"
        backdropFilter="blur(12px) saturate(1.3)"
        css={{ WebkitBackdropFilter: "blur(12px) saturate(1.3)" }}
      >
        <Flex
          mx="auto"
          w="full"
          maxW="1200px"
          h="56px"
          px="6"
          align="center"
          justify="space-between"
          gap="4"
        >
          <Link href="/" aria-label="Narriflow home">
            <Logo size="md" />
          </Link>

          <HStack as="nav" gap="7" display={{ base: "none", md: "flex" }}>
            {NAV_LINKS.map((item) => (
              <Link key={item.label} href={item.href}>
                <Text
                  as="span"
                  fontSize="13.5px"
                  fontWeight="500"
                  color="fg.muted"
                  transition="color 120ms ease"
                  _hover={{ color: "fg" }}
                >
                  {item.label}
                </Text>
              </Link>
            ))}
          </HStack>

          <HStack gap="2">
            <HStack gap="2" display={{ base: "none", md: "flex" }}>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/sign-in">Sign in</Link>
              </Button>
              {/* Outline here — the page hero owns the one solid button */}
              <Button variant="outline" size="sm" px="4" asChild>
                <Link href="/sign-up">Get started</Link>
              </Button>
            </HStack>
            <MarketingMobileNav links={NAV_LINKS} />
          </HStack>
        </Flex>
      </Box>

      {children}

      {/* Footer */}
      <Box as="footer" borderTopWidth="1.5px" borderColor="fg" overflow="hidden">
        <Box mx="auto" maxW="1200px" px="6" pt="16">
          <Flex
            direction={{ base: "column", lg: "row" }}
            gap={{ base: "12", lg: "20" }}
            justify="space-between"
            pb="16"
          >
            <Stack gap="4" maxW="280px">
              <Logo size="md" />
              <Text fontSize="13px" color="fg.muted" lineHeight="1.7">
                Long recordings in. Captioned, virality-scored clips and repurposed
                content out.
              </Text>
              <Stack gap="2" pt="1">
                <Box h="1.5px" w="7" bg="fg" />
                <Text textStyle="eyebrow" color="fg.subtle">
                  Proofed before publish
                </Text>
              </Stack>
            </Stack>

            <SimpleGrid columns={{ base: 2, md: 2 }} gap={{ base: "10", md: "16" }} maxW="480px">
              {FOOTER_COLUMNS.map((column) => (
                <Stack key={column.heading} gap="4">
                  <Text textStyle="eyebrow" color="fg.subtle">
                    {column.heading}
                  </Text>
                  <Stack gap="2.5" align="flex-start">
                    {column.items.map((item) => (
                      <FooterLink key={item.label} href={item.href} label={item.label} />
                    ))}
                  </Stack>
                </Stack>
              ))}
            </SimpleGrid>
          </Flex>

          <Flex
            align="center"
            justify="space-between"
            borderTopWidth="1px"
            borderColor="border.subtle"
            py="5"
            gap="4"
            flexWrap="wrap"
          >
            <Text textStyle="eyebrow" color="fg.subtle">
              &copy; {new Date().getFullYear()} Narriflow
            </Text>
            <Text textStyle="eyebrow" color="fg.subtle">
              All rights reserved
            </Text>
          </Flex>

          {/* Oversized watermark wordmark */}
          <Box aria-hidden="true" userSelect="none" pointerEvents="none" mb="-2%">
            <Text
              fontFamily="display"
              fontWeight="650"
              letterSpacing="-0.04em"
              lineHeight="0.78"
              fontSize={{ base: "26vw", lg: "17.5rem" }}
              color="fg"
              opacity="0.045"
              textAlign="center"
              whiteSpace="nowrap"
            >
              narriflow
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
