import type { Metadata } from "next";
import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { planLimits } from "@narriflow/validators";
import { PlanComparison } from "./plan-comparison";
import { PricingTable } from "./pricing-table";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Credit plans for real clipping workloads. One credit is one minute of source video. Start free, upgrade when you need more.",
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
          title="Credit plans for real clipping workloads."
          description={`Free includes ${planLimits("free").monthlyCredits} credits a month to test the workflow. Upgrade for more credits, watermark-free 1080p exports, publishing, and automation.`}
        />
      </Box>

      <Box animation="fade-up" animationDelay="120ms" animationFillMode="backwards">
        <PricingTable />
      </Box>

      <Box animation="fade-up" animationDelay="160ms" animationFillMode="backwards">
        <PlanComparison />
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
          One credit = one started minute of source video, on every plan. Credits renew on the 1st of each month (UTC) and don't roll over.
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
