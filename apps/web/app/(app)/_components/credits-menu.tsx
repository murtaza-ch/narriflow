"use client";

import Link from "next/link";
import { Box, Flex, Popover, Portal, Stack, Text } from "@chakra-ui/react";
import { CircleAlert, Sparkles } from "lucide-react";
import { PLAN_CATALOG, PRICING_TIER_ORDER, type PricingTier } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { UpgradeButton } from "./upgrade";
import { usagePalette } from "./usage-palette";

/** The next plan up, or `null` on the top plan. */
function nextTier(tier: PricingTier): PricingTier | null {
  return PRICING_TIER_ORDER[PRICING_TIER_ORDER.indexOf(tier) + 1] ?? null;
}

// An explicit locale so the server render and the browser agree.
const formatCredits = (credits: number) => credits.toLocaleString("en-US");

/**
 * What the menu says about this month's credits. Settled and reserved amounts
 * are reported as they are, even past the allowance (a downgrade can leave
 * 900 used against 300); only the bar is capped.
 */
export function creditsPresentation({
  usedCredits,
  reservedCredits,
  limitCredits,
}: { usedCredits: number; reservedCredits: number; limitCredits: number }) {
  const spent = usedCredits + reservedCredits;
  const pct = limitCredits > 0 ? Math.min(100, (spent / limitCredits) * 100) : 0;
  const palette = usagePalette(pct);
  return {
    pct,
    palette,
    /** Stated in words too, so the warning never rests on color alone. */
    status: pct >= 100 ? "No credits left" : palette === "warning" ? "Running low" : null,
    usage: `${formatCredits(usedCredits)} of ${formatCredits(limitCredits)} used${
      reservedCredits > 0 ? ` · ${formatCredits(reservedCredits)} reserved` : ""
    }`,
  };
}

/**
 * Header credit balance (Vizard's pattern): the balance opens a card with the
 * plan, the refresh date and a meter, plus one action: a gold Upgrade for an
 * owner below the top plan, otherwise a link to billing or usage.
 */
export function CreditsMenu({
  remainingCredits,
  usedCredits,
  reservedCredits,
  limitCredits,
  renewsAt,
  tier,
  canManageBilling,
}: {
  remainingCredits: number;
  usedCredits: number;
  reservedCredits: number;
  limitCredits: number;
  renewsAt: string;
  tier: PricingTier;
  canManageBilling: boolean;
}) {
  const upgradeTier = canManageBilling ? nextTier(tier) : null;
  const { pct, palette, status, usage } = creditsPresentation({ usedCredits, reservedCredits, limitCredits });
  const refreshesOn = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(renewsAt));
  const balance = formatCredits(remainingCredits);

  return (
    <Flex align="center" gap="1" p="0.5" borderRadius="control" bg="bg.soft">
      <Popover.Root positioning={{ placement: "bottom-end", offset: { mainAxis: 8 } }}>
        <Popover.Trigger asChild>
          <Button variant="ghost" size="xs" h="28px" px="2.5" fontWeight="500" color={palette === "accent" ? "fg" : `${palette}.fg`} aria-label={`${balance} credits left${status ? `. ${status}` : ""}`}>
            {status ? <CircleAlert size={13} aria-hidden /> : <Sparkles size={13} aria-hidden />}
            <Text as="span" fontVariantNumeric="tabular-nums">{balance}</Text>
            <Text as="span" color="fg.muted" fontWeight="400" display={{ base: "none", xl: "inline" }}>credits</Text>
          </Button>
        </Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content w="300px" p="5">
              <Stack gap="4">
                <Stack gap="1">
                  <Flex align="center" justify="space-between" gap="2">
                    <Text fontSize="16px" fontWeight="600" fontVariantNumeric="tabular-nums">
                      {balance} credits left
                    </Text>
                    <Text fontSize="11px" fontWeight="500" px="2" py="0.5" borderRadius="full" bg="bg.soft" color="fg.muted">
                      {PLAN_CATALOG[tier].name}
                    </Text>
                  </Flex>
                  <Text fontSize="13px" color="fg.muted">Refreshes on {refreshesOn}</Text>
                </Stack>
                <Box>
                  {/* The kit Meter's track disappears on the raised popover fill. */}
                  <Box
                    role="meter"
                    aria-label="Monthly credits used"
                    aria-valuenow={Math.round(pct)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    h="6px"
                    borderRadius="full"
                    bg="bg.emphasized"
                    overflow="hidden"
                  >
                    <Box h="full" w={`${pct}%`} borderRadius="full" bg={`${palette}.solid`} />
                  </Box>
                  <Text mt="2" fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
                    {usage}
                  </Text>
                  {status ? (
                    <Text mt="0.5" fontSize="12px" fontWeight="500" color={`${palette}.fg`}>{status}</Text>
                  ) : null}
                </Box>
                {upgradeTier ? (
                  <UpgradeButton tier={upgradeTier} w="full">Upgrade</UpgradeButton>
                ) : (
                  <Text fontSize="13px">
                    <Link href={canManageBilling ? "/settings/billing" : "/settings/usage"} style={{ textDecoration: "underline", textUnderlineOffset: "3px" }}>
                      {canManageBilling ? "Billing" : "Usage"}
                    </Link>
                  </Text>
                )}
              </Stack>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
      {upgradeTier ? <UpgradeButton tier={upgradeTier} size="xs" h="28px" px="2.5">Upgrade</UpgradeButton> : null}
    </Flex>
  );
}
