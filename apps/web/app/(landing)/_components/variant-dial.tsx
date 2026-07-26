"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, HStack, Text } from "@chakra-ui/react";
import { VARIANTS } from "./landing-data";

/**
 * Floating dial for hopping between the /lp/* design variants while
 * reviewing them. Intentionally chrome-neutral so it reads on any theme.
 */
export function VariantDial() {
  const pathname = usePathname();

  return (
    <Box
      position="fixed"
      bottom="5"
      left="50%"
      transform="translateX(-50%)"
      zIndex="100"
      borderRadius="full"
      bg="rgba(14, 16, 19, 0.82)"
      backdropFilter="blur(12px)"
      border="1px solid rgba(233, 235, 238, 0.14)"
      boxShadow="0 12px 40px rgba(0,0,0,0.35)"
      px="2"
      py="1.5"
      maxW="94vw"
      overflowX="auto"
      css={{ scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }}
    >
      <HStack gap="1" flexWrap="nowrap">
        <Text
          px="2.5"
          fontSize="10px"
          fontFamily="mono"
          letterSpacing="0.18em"
          color="rgba(233, 235, 238, 0.5)"
          display={{ base: "none", sm: "block" }}
        >
          VARIANT
        </Text>
        {VARIANTS.map((v) => {
          const active = pathname === v.href;
          return (
            <Link key={v.key} href={v.href}>
              <Box
                px="3.5"
                py="1.5"
                whiteSpace="nowrap"
                borderRadius="full"
                bg={active ? "#5B6CFF" : "transparent"}
                transition="background 160ms ease, color 160ms ease"
                _hover={{ bg: active ? "#5B6CFF" : "rgba(233,235,238,0.1)" }}
              >
                <Text
                  fontSize="12px"
                  fontWeight="600"
                  color={active ? "#0A0D2A" : "rgba(233,235,238,0.85)"}
                >
                  {v.label}
                </Text>
              </Box>
            </Link>
          );
        })}
      </HStack>
    </Box>
  );
}
