"use client";

import { useState } from "react";
import Link from "next/link";
import { Box, Flex, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { Check } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import {
  PRICING_FEATURES,
  PRICING_TABLE,
  type BillingInterval,
  type PaidPricingTier,
  type PricingTier,
} from "@narriflow/validators";

const TIERS: PricingTier[] = ["free", "creator", "pro", "business"];
const RECOMMENDED_TIER: PricingTier = "creator";

function isPaidTier(tier: PricingTier): tier is PaidPricingTier {
  return tier !== "free";
}

function monthlyPriceFor(tier: PricingTier, interval: BillingInterval): number {
  if (!isPaidTier(tier)) return 0;
  const info = PRICING_TABLE[tier];
  return interval === "annual" ? info.annualUsd / 12 : info.monthlyUsd;
}

function annualSavingsPercent(tier: PaidPricingTier): number {
  const info = PRICING_TABLE[tier];
  return Math.round((1 - info.annualUsd / (info.monthlyUsd * 12)) * 100);
}

/**
 * Comparison bands: four tier columns under drawn rules (accent rule marks
 * the recommended tier), a monthly/annual interval toggle, and feature
 * lists single-sourced from @narriflow/validators.
 */
export function PricingTable() {
  const [interval, setInterval] = useState<BillingInterval>("monthly");

  return (
    <Stack gap="8">
      <Flex justify={{ base: "flex-start", md: "center" }} align="center" gap="3" wrap="wrap">
        <SegmentedControl
          aria-label="Billing interval"
          items={[
            { label: "Monthly", value: "monthly" },
            { label: "Annual", value: "annual" },
          ]}
          value={interval}
          onValueChange={(value) => setInterval(value as BillingInterval)}
        />
        <Text fontSize="12px" color="fg.muted">
          Annual billing saves up to {Math.max(...(["creator", "pro", "business"] as const).map(annualSavingsPercent))}%
        </Text>
      </Flex>

      <SimpleGrid columns={{ base: 1, sm: 2, lg: 4 }} columnGap="8" rowGap="12" alignItems="stretch">
        {TIERS.map((tier) => {
          const recommended = tier === RECOMMENDED_TIER;
          const paid = isPaidTier(tier);
          const name = paid ? PRICING_TABLE[tier].name : "Free";
          const price = monthlyPriceFor(tier, interval);

          return (
            <Stack key={tier} gap="4" position="relative" pt="4">
              {/* The drawn rule — accent for the recommended band */}
              <Box
                position="absolute"
                top="0"
                left="0"
                right="0"
                h="1.5px"
                bg={recommended ? "accent.solid" : "fg"}
              />

              <Flex align="baseline" justify="space-between" gap="2">
                <Text textStyle="eyebrow" color={recommended ? "accent.fg" : "fg.muted"}>
                  {name}
                </Text>
                {recommended && (
                  <Text textStyle="eyebrow" color="accent.fg">
                    Most popular
                  </Text>
                )}
              </Flex>

              <Box>
                <Flex align="baseline" gap="1.5">
                  <Text textStyle="data" fontSize="36px" fontWeight="600" color="fg" lineHeight="1">
                    ${Math.round(price)}
                  </Text>
                  <Text textStyle="data" fontSize="13px" color="fg.muted">
                    /mo
                  </Text>
                </Flex>
                <Text textStyle="data" fontSize="12px" color="fg.subtle" mt="2" minH="18px">
                  {paid
                    ? interval === "annual"
                      ? `billed $${PRICING_TABLE[tier].annualUsd}/yr · save ${annualSavingsPercent(tier)}%`
                      : `or $${PRICING_TABLE[tier].annualUsd}/yr on annual`
                    : "no card required"}
                </Text>
              </Box>

              <Stack gap="0" flex="1">
                {PRICING_FEATURES[tier].map((feature) => (
                  <Flex
                    key={feature}
                    gap="2.5"
                    align="flex-start"
                    py="2"
                    borderTopWidth="1px"
                    borderColor="border.subtle"
                  >
                    <Flex flexShrink={0} pt="0.5" color="fg.muted" aria-hidden="true">
                      <Check size={13} />
                    </Flex>
                    <Text fontSize="13px" color="fg.muted" lineHeight="1.55">
                      {feature}
                    </Text>
                  </Flex>
                ))}
              </Stack>

              <Button
                asChild
                variant={recommended ? "solid" : "outline"}
                size="sm"
              >
                <Link href="/sign-up">{paid ? `Start with ${name}` : "Start free"}</Link>
              </Button>
            </Stack>
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}
