import type { Metadata } from "next";
import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { MONTHLY_PROCESSING_MINUTE_LIMITS } from "@narriflow/validators";
import { PricingTable } from "./pricing-table";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Processing-minute plans for real clipping workloads. Start free, upgrade when you need more source minutes.",
};

export default function PricingPage() {
  return (
    <Stack
      as="main"
      mx="auto"
      w="full"
      maxW="1180px"
      px="6"
      pt={{ base: "14", md: "20" }}
      pb="24"
      gap="10"
    >
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader
          eyebrow="Pricing"
          title="Processing-minute plans for real clipping workloads."
          description={`Free includes ${MONTHLY_PROCESSING_MINUTE_LIMITS.free} minutes to test the workflow. Upgrade when you need more source minutes, no watermark, and production export capacity.`}
        />
      </Box>

      <Box animation="fade-up" animationDelay="120ms" animationFillMode="backwards">
        <PricingTable />
      </Box>

      <Flex
        justify="space-between"
        align="center"
        gap="4"
        wrap="wrap"
        borderTopWidth="1px"
        borderColor="border.subtle"
        pt="5"
        animation="fade-up"
        animationDelay="200ms"
        animationFillMode="backwards"
      >
        <Text fontSize="13px" color="fg.muted">
          One processing minute = one minute of source media, across every tier.
        </Text>
        <Link href="/settings/billing">
          <Text
            as="span"
            fontSize="13px"
            fontWeight="500"
            color="fg"
            textDecoration="underline"
            textUnderlineOffset="3px"
            textDecorationColor="border.emphasized"
            transition="text-decoration-color 120ms ease"
            _hover={{ textDecorationColor: "fg" }}
          >
            Manage an existing plan
          </Text>
        </Link>
      </Flex>
    </Stack>
  );
}
