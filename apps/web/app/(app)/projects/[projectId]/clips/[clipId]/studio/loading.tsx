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
 * Route skeleton mirroring the studio shell: separate panels on the frame —
 * header, transcript, canvas with a 9:16 stage, tool rail, timeline. Keep it
 * in step with studio-shell.tsx so the editor appears without a layout jump.
 */
export default function StudioLoading() {
  return (
    <Flex direction="column" h="100dvh" bg="studio.frame" p="2" gap="2" overflow="hidden">
      {/* Header panel */}
      <Flex h="56px" align="center" px="3" gap="2" bg="studio.canvas" borderRadius="12px" flexShrink={0}>
        <Ghost w="36px" h="36px" borderRadius="l2" />
        <Ghost w="240px" h="18px" />
        <Box flex="1" />
        {[0, 1, 2, 3].map((i) => (
          <Ghost key={i} w="36px" h="36px" borderRadius="l2" />
        ))}
        <Ghost w="56px" h="12px" mx="3" />
        <Ghost w="104px" h="36px" borderRadius="l2" />
      </Flex>

      <Flex flex="1" minH="0" gap="2">
        {/* Transcript panel */}
        <Stack
          w="clamp(320px, 26vw, 480px)"
          flexShrink={0}
          bg="studio.canvas"
          borderRadius="12px"
          px="5"
          py="4"
          gap="7"
          display={{ base: "none", lg: "flex" }}
        >
          <Flex justify="space-between" gap="4">
            <Ghost w="120px" h="14px" />
            <Ghost w="190px" h="14px" />
          </Flex>
          {[0, 1, 2].map((i) => (
            <Stack key={i} gap="3">
              <Ghost w="64px" h="10px" />
              <Ghost w="100%" h="14px" />
              <Ghost w="92%" h="14px" />
              <Ghost w="58%" h="14px" />
            </Stack>
          ))}
        </Stack>

        {/* Canvas panel — aspect and layout controls over a 9:16 stage */}
        <Flex flex="1" minW="0" direction="column" align="center" pt="3" pb="4" gap="4" bg="studio.canvas" borderRadius="12px">
          <HStack gap="3">
            <Ghost w="72px" h="28px" borderRadius="l2" />
            <Ghost w="84px" h="28px" borderRadius="l2" />
          </HStack>
          <Box flex="1" minH="0" aspectRatio={9 / 16} borderRadius="l2" bg="studio.subtle" />
        </Flex>

        {/* Tool rail panel */}
        <Stack w="92px" flexShrink={0} align="center" py="2" gap="0" bg="studio.canvas" borderRadius="12px">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Stack key={i} h="64px" align="center" justify="center" gap="2">
              <Ghost w="22px" h="22px" borderRadius="6px" />
              <Ghost w="40px" h="9px" />
            </Stack>
          ))}
        </Stack>
      </Flex>

      {/* Timeline panel — control bar, then segment, word and waveform lanes */}
      <Box flexShrink={0} bg="studio.canvas" borderRadius="12px" px="6" pb="3">
        <Flex h="52px" align="center" gap="3">
          <Ghost w="110px" h="16px" />
          <Box flex="1" />
          <Ghost w="40px" h="40px" borderRadius="full" />
          <Ghost w="150px" h="16px" />
          <Box flex="1" />
          <Ghost w="200px" h="16px" />
        </Flex>
        <Stack gap="2" pt="6">
          <Ghost w="100%" h="64px" borderRadius="8px" />
          <Ghost w="100%" h="24px" borderRadius="6px" />
          <Ghost w="100%" h="40px" borderRadius="8px" />
        </Stack>
      </Box>
    </Flex>
  );
}
