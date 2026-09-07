"use client";

import { Box, Flex, HStack, Stack, type BoxProps } from "@chakra-ui/react";

/** Graphite shimmer block — the studio skeleton voice. */
function Ghost(props: BoxProps) {
  return (
    <Box
      borderRadius="l1"
      backgroundImage="linear-gradient(90deg, {colors.studio.surface} 25%, {colors.studio.raised} 50%, {colors.studio.surface} 75%)"
      backgroundSize="200% 100%"
      animation="shimmer"
      {...props}
    />
  );
}

/**
 * Route skeleton mirroring the studio shell: top bar, transcript column,
 * center canvas with a 9:16 stage, fixed-width inspector, timeline strip.
 */
export default function StudioLoading() {
  return (
    <Flex direction="column" h="100dvh" bg="studio.canvas" overflow="hidden">
      {/* Top bar */}
      <Flex
        h="48px"
        align="center"
        px="3"
        gap="2"
        bg="studio.surface"
        borderBottomWidth="1px"
        borderColor="studio.border"
        flexShrink={0}
      >
        <Ghost w="32px" h="32px" />
        <Ghost w="220px" h="14px" />
        <Box flex="1" />
        <Ghost w="120px" h="14px" />
        <Ghost w="32px" h="32px" />
        <Ghost w="32px" h="32px" />
        <Ghost w="110px" h="32px" borderRadius="l2" />
      </Flex>

      {/* Main area */}
      <Flex flex="1" overflow="hidden">
        {/* Transcript column */}
        <Stack
          w={{ base: "240px", md: "280px", xl: "300px" }}
          h="100%"
          bg="studio.surface"
          borderRightWidth="1px"
          borderColor="studio.border"
          display={{ base: "none", lg: "flex" }}
          flexShrink={0}
          p="4"
          gap="3"
        >
          <Ghost w="120px" h="12px" />
          {[0, 1, 2, 3, 4].map((i) => (
            <Stack key={i} gap="2" pt="2">
              <Ghost w="64px" h="10px" />
              <Ghost w="100%" h="12px" />
              <Ghost w="86%" h="12px" />
            </Stack>
          ))}
        </Stack>

        {/* Canvas — 9:16 stage */}
        <Flex flex="1" align="center" justify="center" p="6" overflow="hidden">
          <Box
            h="min(100%, 62vh)"
            aspectRatio={9 / 16}
            borderRadius="l2"
            bg="studio.subtle"
            borderWidth="1px"
            borderColor="studio.border"
          />
        </Flex>

        {/* Inspector */}
        <Stack
          w="300px"
          h="100%"
          bg="studio.surface"
          borderLeftWidth="1px"
          borderColor="studio.border"
          display={{ base: "none", md: "flex" }}
          flexShrink={0}
          p="3"
          gap="3"
        >
          <HStack gap="2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Ghost key={i} w="36px" h="36px" borderRadius="l2" />
            ))}
          </HStack>
          <Ghost w="100%" h="80px" borderRadius="l2" />
          <Ghost w="100%" h="44px" borderRadius="l2" />
          <Ghost w="70%" h="12px" />
          <Ghost w="100%" h="44px" borderRadius="l2" />
        </Stack>
      </Flex>

      {/* Timeline strip */}
      <Box
        flexShrink={0}
        bg="studio.canvas"
        borderTopWidth="1px"
        borderColor="studio.border"
      >
        <Flex h="40px" align="center" px="3" gap="2" borderBottomWidth="1px" borderColor="studio.border">
          <Ghost w="90px" h="20px" />
          <Box flex="1" />
          <Ghost w="32px" h="32px" borderRadius="full" />
          <Ghost w="140px" h="14px" />
          <Box flex="1" />
          <Ghost w="120px" h="14px" />
        </Flex>
        <Flex h="132px" align="center" px="10" gap="2">
          <Ghost w="100%" h="64px" borderRadius="l1" />
        </Flex>
      </Box>
    </Flex>
  );
}
