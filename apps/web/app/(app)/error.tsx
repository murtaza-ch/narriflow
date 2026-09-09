"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { GhostFrame } from "@narriflow/ui/components/ghost-frame";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.warn(JSON.stringify({ level: "error", message: "app_error_boundary", errorName: error instanceof Error ? error.name : "UnknownError" }));
  }, [error]);

  return (
    <Flex data-page-error="" width="full" position="relative" minH="60dvh" align="center" justify="center" p="6" overflow="hidden">
      {/* Blueprint-grid atmosphere, fading toward the center */}
      <Box
        position="absolute"
        inset="0"

        style={{
          maskImage: "radial-gradient(ellipse 75% 75% at center, transparent 22%, black 55%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(ellipse 75% 75% at center, transparent 22%, black 55%, transparent 100%)",
        }}
        pointerEvents="none"
      />
      <Stack gap="5" maxW="420px" align="center" textAlign="center" position="relative" animation="fade-up">
        <GhostFrame ratio={16 / 9} size="240px">
          <Box color="danger.fg">
            <TriangleAlert size={24} />
          </Box>
        </GhostFrame>
        <Stack gap="1.5" align="center">
          <Text textStyle="eyebrow" color="danger.fg">
            Error
          </Text>
          <Heading as="h1" textStyle="title" fontSize="22px">
            Something went wrong
          </Heading>
          <Text textStyle="sm" color="fg.muted" lineHeight="1.6">
            We hit an unexpected error loading this page. You can try again,
            and if it keeps happening, contact support.
          </Text>
          {error.digest && (
            <Text textStyle="data" fontSize="12px" color="fg.subtle">
              Ref {error.digest}
            </Text>
          )}
        </Stack>
        <Flex align="center" gap="5" pt="1">
          <Button onClick={reset}>Try again</Button>
          <Box
            asChild
            fontSize="14px"
            color="fg"
            textDecoration="underline"
            textUnderlineOffset="3px"
            transition="color 120ms ease"
            _hover={{ color: "fg.accent" }}
          >
            <Link href="/home">Go to home</Link>
          </Box>
        </Flex>
      </Stack>
    </Flex>
  );
}
