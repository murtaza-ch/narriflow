import { Box, Heading, Text } from "@chakra-ui/react";

export default function PricingPage() {
  return (
    <Box as="main" mx="auto" w="full" maxW="5xl" px="6" py="16">
      <Heading size="xl" fontWeight="semibold" letterSpacing="tight">
        Pricing
      </Heading>
      <Text mt="2" color="fg.muted">
        Starter pricing placeholder. Connect Stripe product catalog next.
      </Text>
    </Box>
  );
}
