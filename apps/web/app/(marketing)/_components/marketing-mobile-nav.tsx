"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, Drawer, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { Menu as MenuIcon, X } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { Button } from "@narriflow/ui/components/button";

interface MarketingMobileNavProps {
  links: Array<{ label: string; href: string }>;
}

/**
 * Base-breakpoint marketing nav — hamburger opening a Drawer so Pricing
 * (and everything else) is reachable on phones. Closes on route change.
 */
export function MarketingMobileNav({ links }: MarketingMobileNavProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is an intentional route-change trigger.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Box display={{ base: "block", md: "none" }}>
      <Drawer.Root open={open} onOpenChange={(details) => setOpen(details.open)} placement="end">
        <Drawer.Trigger asChild>
          <Flex
            as="button"
            aria-label="Open menu"
            align="center"
            justify="center"
            w="9"
            h="9"
            borderRadius="l2"
            color="fg.muted"
            cursor="pointer"
            transition="background 120ms ease, color 120ms ease"
            _hover={{ bg: "bg.subtle", color: "fg" }}
          >
            <MenuIcon size={20} />
          </Flex>
        </Drawer.Trigger>

        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content bg="bg" maxW="300px" display="flex" flexDirection="column">
              <Flex
                h="56px"
                align="center"
                justify="space-between"
                px="4"
                borderBottomWidth="1px"
                borderColor="border.subtle"
                flexShrink={0}
              >
                <Logo size="sm" />
                <Drawer.CloseTrigger asChild>
                  <Flex
                    as="button"
                    aria-label="Close menu"
                    align="center"
                    justify="center"
                    w="8"
                    h="8"
                    borderRadius="l2"
                    color="fg.muted"
                    cursor="pointer"
                    transition="background 120ms ease, color 120ms ease"
                    _hover={{ bg: "bg.subtle", color: "fg" }}
                  >
                    <X size={18} />
                  </Flex>
                </Drawer.CloseTrigger>
              </Flex>

              <Stack as="nav" flex="1" px="4" py="4" gap="0">
                {links.map((item) => (
                  <Link key={item.href} href={item.href}>
                    <Text
                      py="3"
                      fontSize="15px"
                      fontWeight="500"
                      color="fg"
                      borderBottomWidth="1px"
                      borderColor="border.subtle"
                      transition="color 120ms ease"
                      _hover={{ color: "fg.muted" }}
                    >
                      {item.label}
                    </Text>
                  </Link>
                ))}
              </Stack>

              <Stack px="4" py="4" gap="2" borderTopWidth="1px" borderColor="border.subtle">
                <Button asChild variant="outline" w="full">
                  <Link href="/sign-in">Sign in</Link>
                </Button>
                <Button asChild w="full">
                  <Link href="/sign-up">Get started</Link>
                </Button>
              </Stack>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>
    </Box>
  );
}
