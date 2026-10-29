"use client";

import Link from "next/link";
import { Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { Link2Off } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";

/** A shared clip link that is expired, revoked, or has nothing to play yet. */
export default function SharedClipUnavailable() {
  return (
    <Flex as="main" minH="100dvh" bg="bg.sidebar" direction="column" align="center" justify="center" gap="6" px="4" py="10">
      <Logo size="md" />
      <Stack w="full" maxW="440px" align="center" textAlign="center" gap="5" p={{ base: "6", sm: "8" }} bg="bg.panel" borderRadius="l3">
        <Flex boxSize="12" align="center" justify="center" borderRadius="full" bg="bg.soft" color="fg.muted" aria-hidden>
          <Link2Off size={20} />
        </Flex>
        <Stack gap="1.5">
          <Heading as="h1" textStyle="title" fontSize="22px">
            This link isn&apos;t available
          </Heading>
          <Text fontSize="14px" color="fg.muted">
            It may have expired or been turned off by the sender. Ask them for a new link.
          </Text>
        </Stack>
        <Button asChild variant="subtle">
          <Link href="/">Visit Narriflow</Link>
        </Button>
      </Stack>
    </Flex>
  );
}
