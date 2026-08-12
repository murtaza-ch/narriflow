"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Check } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  MAX_UPLOAD_LENGTH_SECONDS,
  MONTHLY_PROCESSING_MINUTE_LIMITS,
  PRICING_TABLE,
  type BillingInterval,
  type PaidPricingTier,
  type PricingTier,
} from "@narriflow/validators";

const TIER_RANK: Record<PricingTier, number> = {
  free: 0,
  creator: 1,
  pro: 2,
  business: 3,
};

export function BillingPlans({
  currentTier,
  availableTiers,
  isConfigured,
  checkoutSucceeded = false,
  workspaceStatus = "active",
  canManageBilling = false,
}: {
  currentTier: PricingTier;
  availableTiers: PaidPricingTier[];
  isConfigured: boolean;
  checkoutSucceeded?: boolean;
  workspaceStatus?: "active" | "pending_payment" | "restricted";
  canManageBilling?: boolean;
}) {
  const router = useRouter();
  const [interval, setInterval] = useState<BillingInterval>("annual");
  const [busy, setBusy] = useState<string | null>(null);
  const successFired = useRef(false);

  const isPaid = currentTier !== "free";

  // Post-checkout return: celebrate once, then strip the query param so a
  // refresh doesn't re-toast.
  useEffect(() => {
    if (!checkoutSucceeded || successFired.current) return;
    successFired.current = true;
    toaster.create({
      type: "success",
      title: "You're upgraded",
      description: "Your new plan limits are active.",
    });
    router.replace("/settings/subscription", { scroll: false });
  }, [checkoutSucceeded, router]);

  async function post(url: string, body?: unknown): Promise<string> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as {
      url?: string;
      message?: string;
      error?: string;
    };
    if (!res.ok || !json.url) {
      throw new Error(json.message ?? json.error ?? "Something went wrong");
    }
    return json.url;
  }

  async function checkout(tier: PaidPricingTier) {
    setBusy(tier);
    try {
      window.location.href = await post("/api/billing/checkout", {
        tier,
        interval,
      });
    } catch (e) {
      toaster.create({
        type: "error",
        title: "Checkout failed",
        description: e instanceof Error ? e.message : "Please try again.",
      });
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    try {
      window.location.href = await post("/api/billing/portal");
    } catch (e) {
      toaster.create({
        type: "error",
        title: "Could not open billing portal",
        description: e instanceof Error ? e.message : "Please try again.",
      });
      setBusy(null);
    }
  }

  if (!isConfigured || availableTiers.length === 0) {
    return (
      <Box as="section">
        <Text textStyle="eyebrow" color="fg.subtle" mb="2">
          Plans
        </Text>
        <Box layerStyle="band">
          <Text fontSize="13px" color="fg.muted">
            Billing isn&apos;t configured yet. Once Stripe keys and plan prices
            are set, upgrade options appear here.
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Stack gap="5" as="section">
      <Flex align="center" justify="space-between" gap="3" wrap="wrap">
        <Text textStyle="eyebrow" color="fg.subtle">
          Plans
        </Text>
        <SegmentedControl
          size="sm"
          aria-label="Billing interval"
          items={[
            { label: "Monthly", value: "monthly" },
            { label: "Annual · save ~33%", value: "annual" },
          ]}
          value={interval}
          onValueChange={(value) => setInterval(value as BillingInterval)}
        />
      </Flex>

      {/* Plan comparison — rule-band columns divided by hairlines */}
      <Grid
        layerStyle="band"
        templateColumns={{
          base: "1fr",
          md: `repeat(${Math.min(3, availableTiers.length)}, minmax(0, 1fr))`,
        }}
        columnGap="0"
        rowGap={{ base: "6", md: "0" }}
      >
        {availableTiers.map((tier, index) => {
          const info = PRICING_TABLE[tier];
          const isCurrent = currentTier === tier;
          const needsCheckout = isCurrent && workspaceStatus === "pending_payment";
          const isDowngrade = TIER_RANK[currentTier] > TIER_RANK[tier];
          const perMonth =
            interval === "annual"
              ? (info.annualUsd / 12).toFixed(0)
              : String(info.monthlyUsd);
          const recommended = tier === "creator";
          const uploadCapMin = MAX_UPLOAD_LENGTH_SECONDS[tier] / 60;

          return (
            <Stack
              key={tier}
              gap="3"
              minW="0"
              paddingInlineEnd={{ base: "0", md: "5" }}
              paddingInlineStart={{ base: "0", md: index === 0 ? "0" : "5" }}
              pt={{ base: index === 0 ? "0" : "5", md: "1" }}
              borderInlineStartWidth={{ base: "0", md: index === 0 ? "0" : "1px" }}
              borderTopWidth={{ base: index === 0 ? "0" : "1px", md: "0" }}
              borderColor="border"
            >
              {/* Structural current-plan mark: 3px accent top-rule + label */}
              {isCurrent ? (
                <Box>
                  <Box h="3px" w="full" bg="accent.solid" mb="1.5" />
                  <Text textStyle="eyebrow" color="accent.fg">
                    {needsCheckout ? "Payment pending" : "Current plan"}
                  </Text>
                </Box>
              ) : recommended ? (
                <Box>
                  <Box h="3px" w="10" bg="border.emphasized" mb="1.5" />
                  <Text textStyle="eyebrow" color="fg.subtle">
                    Recommended
                  </Text>
                </Box>
              ) : (
                <Box>
                  <Box h="3px" w="10" bg="transparent" mb="1.5" />
                  <Text textStyle="eyebrow" color="transparent" aria-hidden="true">
                    &nbsp;
                  </Text>
                </Box>
              )}

              <Text textStyle="title" fontSize="16px" color="fg">
                {info.name}
              </Text>

              <Stack gap="1">
                <Flex align="baseline" gap="1">
                  <Text
                    textStyle="data"
                    fontSize="28px"
                    lineHeight="1.15"
                    color="fg"
                  >
                    ${perMonth}
                  </Text>
                  <Text fontSize="13px" color="fg.muted">
                    /mo
                  </Text>
                </Flex>
                <Text textStyle="data" fontSize="12px" color="fg.subtle">
                  {interval === "annual"
                    ? `$${info.annualUsd} billed yearly`
                    : "billed monthly"}
                </Text>
              </Stack>

              {/* Feature rows — hairline mini-rows, mono values */}
              <Stack gap="0" mt="2">
                <Flex
                  justify="space-between"
                  align="baseline"
                  gap="3"
                  py="2"
                  borderTopWidth="1px"
                  borderColor="border.subtle"
                >
                  <Text fontSize="13px" color="fg.muted">
                    Processing
                  </Text>
                  <Text textStyle="data" fontSize="13px" color="fg">
                    {MONTHLY_PROCESSING_MINUTE_LIMITS[tier]} min/mo
                  </Text>
                </Flex>
                <Flex
                  justify="space-between"
                  align="baseline"
                  gap="3"
                  py="2"
                  borderTopWidth="1px"
                  borderColor="border.subtle"
                >
                  <Text fontSize="13px" color="fg.muted">
                    Upload cap
                  </Text>
                  <Text textStyle="data" fontSize="13px" color="fg">
                    {uploadCapMin} min
                  </Text>
                </Flex>
              </Stack>

              <Box mt="1">
                {isCurrent && !needsCheckout ? (
                  <Button size="sm" variant="outline" disabled width="100%">
                    <Check size={14} />
                    Current plan
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={recommended ? "solid" : "outline"}
                    width="100%"
                    loading={busy === tier}
                    disabled={busy !== null || isDowngrade || !canManageBilling}
                    onClick={() => checkout(tier)}
                  >
                    {needsCheckout
                      ? "Complete checkout"
                      : isDowngrade
                        ? "Included"
                        : `Upgrade to ${info.name}`}
                  </Button>
                )}
              </Box>
            </Stack>
          );
        })}
      </Grid>

      {isPaid && workspaceStatus !== "pending_payment" && canManageBilling ? (
        <Box>
          <Button
            size="sm"
            variant="ghost"
            colorPalette="gray"
            loading={busy === "portal"}
            disabled={busy !== null}
            onClick={openPortal}
          >
            Manage subscription &amp; invoices
          </Button>
        </Box>
      ) : null}
      {!canManageBilling ? (
        <Text fontSize="12px" color="fg.subtle">
          Only the workspace owner can change its subscription or payment method.
        </Text>
      ) : null}
    </Stack>
  );
}
