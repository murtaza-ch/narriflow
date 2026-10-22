import Link from "next/link";
import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { SearchX } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";

export default function NotFound() {
  return (
    <Flex position="relative" minH="60dvh" align="center" justify="center" p="6" overflow="hidden">
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
        <Box color="fg.subtle">
          <SearchX size={20} />
        </Box>
        <Stack gap="1.5" align="center">
          <Heading as="h1" textStyle="title" fontSize="22px">
            Page not found
          </Heading>
          <Text textStyle="sm" color="fg.muted" lineHeight="1.6">
            We couldn&apos;t find the page you were looking for. It may have
            been moved or deleted.
          </Text>
        </Stack>
        <Button asChild mt="1">
          <Link href="/home">Back to home</Link>
        </Button>
      </Stack>
    </Flex>
  );
}
