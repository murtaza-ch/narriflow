import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { Flex, VStack, Heading, Text, HStack, Box } from "@chakra-ui/react";

export default function MarketingHomePage() {
  return (
    <VStack as="main" mx="auto" minH="calc(100vh - 65px)" w="full" maxW="6xl" justify="center" gap="8" px="6" py="16" textAlign="center">
      <Text as="span" rounded="full" borderWidth="1px" borderColor="border" px="3" py="1" textStyle="xs" color="fg.muted">
        AI Content Repurposing Platform
      </Text>
      <Heading maxW="4xl" size={{ base: "2xl", sm: "3xl" }} fontWeight="semibold" letterSpacing="tight">
        Turn one long-form recording into clips, carousels, threads, and newsletters.
      </Heading>
      <Text maxW="2xl" textStyle={{ base: "md", sm: "lg" }} color="fg.muted">
        Narriflow orchestrates ingest, transcription, moment detection, rendering, and distribution from one
        workflow.
      </Text>
      <HStack gap="3">
        <Button asChild>
          <Link href="/projects">Start in App</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/pricing">View Pricing</Link>
        </Button>
      </HStack>
    </VStack>
  );
}
