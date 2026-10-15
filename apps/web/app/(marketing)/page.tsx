import Link from "next/link";
import { Box, Heading, HStack, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { StartLink } from "./_components/account-actions";

export default function MarketingHomePage() {
  return (
    <Box as="main" mx="auto" w="full" maxW="1200px" px="6" py={{ base: "20", md: "32" }}>
      <Stack as="section" gap="6" maxW="720px">
        <Heading as="h1" fontSize={{ base: "4xl", md: "6xl" }} lineHeight="1.1" letterSpacing="tight">
          Turn long videos into clips worth sharing.
        </Heading>
        <Text fontSize={{ base: "lg", md: "xl" }} color="fg.muted" lineHeight="1.7" maxW="600px">
          Find the best moments, add captions, and publish short clips with Narriflow.
        </Text>
        <HStack gap="4" flexWrap="wrap">
          <Button size="lg" asChild>
            <StartLink>Start for free</StartLink>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link href="/pricing">View pricing</Link>
          </Button>
        </HStack>
      </Stack>
    </Box>
  );
}
