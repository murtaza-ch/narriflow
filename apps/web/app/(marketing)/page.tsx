import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { VStack, Heading, Text, HStack, Box, Flex } from "@chakra-ui/react";

export default function MarketingHomePage() {
  return (
    <VStack as="main" mx="auto" w="full" maxW="1200px" px="6">
      {/* Hero */}
      <VStack
        minH="calc(100vh - 56px)"
        justify="center"
        gap="0"
        textAlign="center"
        pt="80px"
        pb="40px"
      >
        {/* Badge */}
        <Text
          as="span"
          display="inline-flex"
          borderRadius="full"
          borderWidth="1px"
          borderColor="border.accent"
          bg="accent.subtle"
          px="12px"
          py="4px"
          fontSize="12px"
          fontWeight="500"
          color="fg.accent"
          mb="24px"
        >
          AI Content Repurposing Platform
        </Text>

        {/* Headline */}
        <Heading
          maxW="720px"
          fontSize={{ base: "32px", md: "48px" }}
          fontWeight="700"
          letterSpacing="-0.03em"
          lineHeight="1.1"
          color="fg"
        >
          Turn one long-form recording into clips, carousels, threads, and newsletters.
        </Heading>

        {/* Subtitle */}
        <Text
          maxW="540px"
          fontSize={{ base: "15px", md: "17px" }}
          lineHeight="1.6"
          color="fg.muted"
          mt="20px"
        >
          Narriflow orchestrates ingest, transcription, moment detection, rendering,
          and distribution from one workflow.
        </Text>

        {/* CTAs */}
        <HStack gap="12px" mt="32px">
          <Button size="lg" asChild>
            <Link href="/sign-up">Start for free</Link>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <Link href="/pricing">View Pricing</Link>
          </Button>
        </HStack>

        {/* Social proof placeholder */}
        <Flex align="center" gap="8px" mt="40px">
          <HStack gap="-8px">
            {[...Array(4)].map((_, i) => (
              <Box
                key={i}
                w="28px"
                h="28px"
                borderRadius="full"
                bg="bg.muted"
                borderWidth="2px"
                borderColor="bg"
              />
            ))}
          </HStack>
          <Text fontSize="13px" color="fg.muted">
            Trusted by creators worldwide
          </Text>
        </Flex>

        {/* Product screenshot placeholder */}
        <Box
          mt="64px"
          w="full"
          maxW="960px"
          aspectRatio="16/9"
          borderRadius="12px"
          borderWidth="1px"
          borderColor="border"
          bg="bg.subtle"
          shadow="md"
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          <Text fontSize="13px" color="fg.subtle">
            Product screenshot
          </Text>
        </Box>
      </VStack>
    </VStack>
  );
}
