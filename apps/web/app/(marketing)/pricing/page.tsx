import { Box, Heading, Text, VStack } from "@chakra-ui/react";

export default function PricingPage() {
  return (
    <VStack as="main" mx="auto" w="full" maxW="1200px" px="6" py="80px" gap="16px" textAlign="center">
      <Heading
        fontSize={{ base: "28px", md: "36px" }}
        fontWeight="700"
        letterSpacing="-0.03em"
      >
        Simple, transparent pricing
      </Heading>
      <Text fontSize="15px" color="fg.muted" maxW="480px">
        Plans and pricing are coming soon. Connect your Stripe product catalog to go live.
      </Text>
      <Box
        mt="24px"
        w="full"
        maxW="400px"
        borderRadius="12px"
        borderWidth="1px"
        borderColor="border"
        bg="bg.panel"
        p="32px"
        textAlign="center"
      >
        <Text fontSize="13px" color="fg.subtle">
          Pricing details coming soon
        </Text>
      </Box>
    </VStack>
  );
}
