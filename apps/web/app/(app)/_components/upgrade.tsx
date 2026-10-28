"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Box, chakra, Flex, RadioGroup, Stack, Text, type FlexProps } from "@chakra-ui/react";
import { Check, Gem } from "lucide-react";
import {
  PLAN_CATALOG,
  annualSavingsPercent,
  formatUsdCents,
  planHighlights,
  type BillingInterval,
  type PaidPricingTier,
  type PricingTier,
} from "@narriflow/validators";
import { Button, type ButtonProps } from "@narriflow/ui/components/button";
import { CloseButton, Dialog, Portal } from "@narriflow/ui/components/dialog";
import { FeatureHero } from "./feature-hero";

/**
 * How this workspace changes plan, from its billing view's allowed actions:
 * a first subscription goes through Checkout (the dialog offers an interval),
 * a live subscription reviews its plan change in billing, and anything else
 * (activation, retry, repair) is handled on the billing page itself.
 */
export type UpgradeBillingMode = "checkout" | "change_plan" | "billing";

interface UpgradeContextValue {
  currentTier: PricingTier;
  billingMode: UpgradeBillingMode;
  /** Owner of an active workspace: the only actor who can change the plan. */
  canManageBilling: boolean;
  /** Open the shared upgrade dialog. It sends no request; it only explains and links to billing. */
  openUpgrade: (prompt: UpgradePrompt) => void;
}

const UpgradeContext = createContext<UpgradeContextValue>({
  currentTier: "free",
  billingMode: "billing",
  canManageBilling: false,
  openUpgrade: () => {},
});

export function useUpgrade(): UpgradeContextValue {
  return useContext(UpgradeContext);
}

/**
 * Provided once by the app layout. Renders the one upgrade dialog every
 * prompt, locked button and runtime refusal opens.
 */
export function UpgradeProvider({
  currentTier,
  billingMode,
  canManageBilling,
  children,
}: {
  currentTier: PricingTier;
  billingMode: UpgradeBillingMode;
  canManageBilling: boolean;
  children: ReactNode;
}) {
  const [prompt, setPrompt] = useState<UpgradePrompt | null>(null);
  const [open, setOpen] = useState(false);
  const value = useMemo<UpgradeContextValue>(
    () => ({
      currentTier,
      billingMode,
      canManageBilling,
      openUpgrade: (next) => {
        if (!next.tier || next.tier === "free") return;
        setPrompt(next);
        setOpen(true);
      },
    }),
    [currentTier, billingMode, canManageBilling],
  );
  return (
    <UpgradeContext.Provider value={value}>
      {children}
      <UpgradeDialog prompt={prompt} open={open} onOpenChange={setOpen} />
    </UpgradeContext.Provider>
  );
}

/** The billing page, opened on `tier` (and `interval`) when one is known. */
export function upgradeHref(tier?: PricingTier | null, interval?: BillingInterval): string {
  const params = new URLSearchParams();
  if (tier && tier !== "free") params.set("plan", tier);
  if (interval) params.set("interval", interval);
  const query = params.toString();
  return `/settings/billing${query ? `?${query}` : ""}#plans`;
}

/** The soft-gold fill every upgrade call to action shares. */
const upgradeFill = {
  bg: "upgrade.solid",
  color: "upgrade.fg",
  _hover: { bg: "upgrade.solidHover" },
  _expanded: { bg: "upgrade.solidHover" },
} as const;

/** Gold "Upgrade" link to the billing page. */
export function UpgradeButton({
  tier,
  children = "Upgrade",
  ...rest
}: { tier?: PricingTier | null; children?: ReactNode } & Omit<ButtonProps, "asChild">) {
  return (
    <Button size="sm" {...upgradeFill} {...rest} asChild>
      <Link href={upgradeHref(tier)}>
        <Gem size={14} aria-hidden />
        {children}
      </Link>
    </Button>
  );
}

/** Gold gem marking a nav item whose feature the plan doesn't include. */
export function UpgradeGem({ label = "Needs an upgrade" }: { label?: string }) {
  return (
    <Box as="span" ms="auto" color="upgrade.fg" display="inline-flex" role="img" aria-label={label}>
      <Gem size={13} aria-hidden />
    </Box>
  );
}

/** Small gold chip naming the plan a locked feature needs. */
export function PlanBadge({ tier, ...rest }: { tier: PricingTier } & FlexProps) {
  return (
    <Flex
      as="span"
      display="inline-flex"
      align="center"
      gap="1"
      px="1.5"
      h="18px"
      borderRadius="full"
      bg="upgrade.subtle"
      color="upgrade.fg"
      fontSize="11px"
      fontWeight="500"
      lineHeight="1"
      whiteSpace="nowrap"
      flexShrink={0}
      {...rest}
    >
      <Gem size={10} aria-hidden />
      {PLAN_CATALOG[tier].name}
    </Flex>
  );
}

/**
 * Slim pill that names one thing an upgrade unlocks right where the user
 * meets the limit (OpusClip's "Unlock watermark-free exports" banner).
 */
export function UpgradeBanner({
  message,
  tier,
  canManageBilling: canManageBillingProp,
}: {
  message: string;
  tier: PricingTier | null;
  canManageBilling?: boolean;
}) {
  const context = useUpgrade();
  const canManageBilling = canManageBillingProp ?? context.canManageBilling;
  return (
    <Flex
      align="center"
      gap="3"
      wrap="wrap"
      alignSelf="flex-start"
      ps="3"
      pe={canManageBilling ? "1.5" : "3"}
      py="1.5"
      borderRadius="full"
      bg="upgrade.subtle"
    >
      <Flex align="center" gap="2" fontSize="13px" color="fg">
        <Box color="upgrade.fg" display="inline-flex"><Gem size={14} aria-hidden /></Box>
        <Text>{message}</Text>
      </Flex>
      {canManageBilling ? (
        <UpgradeButton tier={tier} size="xs" h="26px" borderRadius="full">
          Upgrade
        </UpgradeButton>
      ) : (
        <Text fontSize="12px" color="fg.muted">Ask the workspace owner to upgrade.</Text>
      )}
    </Flex>
  );
}

export interface UpgradePrompt {
  /** The plan that unlocks the action. */
  tier: PricingTier | null;
  /** What the dialog promises, e.g. "Upgrade to build your brand kit". */
  headline: string;
  /** The first, emphasized line: what the plan adds for this gate (see `planUpgradeHighlight`). */
  highlight?: string;
  /** Only the owner can change the plan; everyone else is told whom to ask. Defaults to the layout's answer. */
  canManageBilling?: boolean;
}

/** Lowercase words of four or more letters, for spotting two lines about the same thing. */
function significantWords(line: string): string[] {
  return line.toLowerCase().match(/[a-z]{4,}/g) ?? [];
}

/** One billing interval as a full-width radio row: dot, label, monthly price. */
function IntervalOption({
  value,
  label,
  monthlyCents,
  note,
  savePercent,
}: {
  value: BillingInterval;
  label: string;
  monthlyCents: number;
  note: string;
  savePercent?: number;
}) {
  return (
    <RadioGroup.Item
      value={value}
      display="flex"
      alignItems="center"
      gap="3"
      w="full"
      px="4"
      py="3"
      borderRadius="l2"
      cursor="pointer"
      bg="bg.soft"
      transition="background 120ms ease"
      _hover={{ bg: "bg.softHover" }}
      _checked={{ bg: "accent.subtle" }}
    >
      <RadioGroup.ItemHiddenInput />
      <RadioGroup.ItemIndicator />
      <Box flex="1" minW="0">
        <Flex align="center" gap="2">
          <RadioGroup.ItemText fontSize="14px" fontWeight="500" color="fg">{label}</RadioGroup.ItemText>
          {savePercent ? (
            <Text as="span" fontSize="11px" fontWeight="600" px="1.5" py="0.5" borderRadius="full" bg="upgrade.solid" color="upgrade.fg">
              Save {savePercent}%
            </Text>
          ) : null}
        </Flex>
        <Text fontSize="12px" color="fg.muted">{note}</Text>
      </Box>
      <Text fontSize="15px" fontWeight="600" color="fg" fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
        {formatUsdCents(monthlyCents)}
        <Text as="span" fontSize="12px" fontWeight="400" color="fg.muted">/mo</Text>
      </Text>
    </RadioGroup.Item>
  );
}

/**
 * Contextual upgrade dialog (Vizard's pattern): the headline names what the
 * user tried to do, the first benefit is the gate they hit, the interval is a
 * pair of priced rows, and the button opens billing with both already chosen.
 */
function UpgradeDialogBody({ prompt, onClose }: { prompt: UpgradePrompt; onClose: () => void }) {
  const [interval, setInterval] = useState<BillingInterval>("annual");
  const context = useUpgrade();
  const { tier, headline, highlight } = prompt;
  const canManageBilling = prompt.canManageBilling ?? context.canManageBilling;
  if (!tier || tier === "free") return null;
  // First subscriptions pick an interval here; paid owners review the exact
  // charge and timing in billing, starting from their existing interval.
  const choosingInterval = context.billingMode === "checkout";
  const paidTier: PaidPricingTier = tier;
  const plan = PLAN_CATALOG[paidTier];
  // Lead with the gate, drop catalog lines about the same thing ("Autopilot:
  // 3 active rules" after "Up to 3 active Autopilot rules"), and skip
  // "Everything in Creator", which says nothing on its own.
  const leadWords = significantWords(highlight ?? "");
  const benefits = [
    highlight,
    ...planHighlights(paidTier).filter(
      (line) => !line.startsWith("Everything in") && !significantWords(line).some((word) => leadWords.includes(word)),
    ),
  ]
    .filter((line): line is string => Boolean(line))
    .slice(0, 5);

  return (
    <>
      <Flex align="center" justify="space-between" mb="3">
        <PlanBadge tier={paidTier} />
        <Dialog.CloseTrigger asChild position="static">
          <CloseButton size="sm" me="-2" />
        </Dialog.CloseTrigger>
      </Flex>
      <Dialog.Title textStyle="title" fontSize="19px" lineHeight="1.3" color="fg">
        {headline}
      </Dialog.Title>

      <Stack as="ul" gap="2.5" listStyleType="none" mt="5">
        {benefits.map((line, index) => {
          const lead = index === 0 && Boolean(highlight);
          return (
            <Flex as="li" key={line} gap="2.5" fontSize="14px" lineHeight="20px">
              <Flex h="20px" align="center" color="accent.fg" flexShrink={0}>
                <Check size={15} aria-hidden />
              </Flex>
              <Text color={lead ? "fg" : "fg.muted"} fontWeight={lead ? "500" : "400"}>{line}</Text>
            </Flex>
          );
        })}
      </Stack>

      {!choosingInterval ? (
        <Flex align="baseline" gap="1.5" mt="6" px="4" py="3" borderRadius="l2" bg="bg.soft" wrap="wrap">
          <Text fontSize="15px" fontWeight="600" color="fg" fontVariantNumeric="tabular-nums">
            {formatUsdCents(plan.monthlyPriceCents)}
            <Text as="span" fontSize="12px" fontWeight="400" color="fg.muted">/mo</Text>
          </Text>
          <Text fontSize="12.5px" color="fg.muted">
            or {formatUsdCents(Math.round(plan.annualPriceCents / 12))}/mo billed yearly.
            {context.billingMode === "change_plan" ? " Review the amount and timing in billing." : ""}
          </Text>
        </Flex>
      ) : (
      <RadioGroup.Root
        value={interval}
        onValueChange={(details) => { if (details.value) setInterval(details.value as BillingInterval); }}
        colorPalette="accent"
        aria-label="Billing interval"
        mt="6"
      >
        <Stack gap="2">
          <IntervalOption value="monthly" label="Monthly" monthlyCents={plan.monthlyPriceCents} note="Billed monthly" />
          <IntervalOption
            value="annual"
            label="Annual"
            monthlyCents={Math.round(plan.annualPriceCents / 12)}
            note={`Billed ${formatUsdCents(plan.annualPriceCents)} yearly`}
            savePercent={annualSavingsPercent(paidTier)}
          />
        </Stack>
      </RadioGroup.Root>
      )}

      <Stack gap="3" mt="6">
        {canManageBilling ? (
          <Button w="full" size="lg" asChild>
            <Link href={upgradeHref(paidTier, choosingInterval ? interval : undefined)} onClick={onClose}>
              {context.billingMode === "change_plan" ? `Switch to ${plan.name}` : context.billingMode === "checkout" ? `Upgrade to ${plan.name}` : "Go to billing"}
            </Link>
          </Button>
        ) : (
          <Text fontSize="13px" color="fg.muted" textAlign="center">
            Only the workspace owner can change the plan. Ask them to upgrade to {plan.name}.
          </Text>
        )}
        <Text fontSize="12.5px" color="fg.muted" textAlign="center">
          <Link href="/pricing" target="_blank" style={{ textDecoration: "underline", textUnderlineOffset: "3px" }}>
            Compare all plans
          </Link>
        </Text>
      </Stack>
    </>
  );
}

/**
 * The dialog root stays mounted (closed) for the provider's lifetime. Mounting
 * it already open leaves Zag's aria-hidden on the app after it closes.
 */
function UpgradeDialog({
  prompt,
  open,
  onOpenChange,
}: { prompt: UpgradePrompt | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const active = prompt?.tier && prompt.tier !== "free" ? prompt : null;
  return (
    <Dialog.Root open={open && active !== null} onOpenChange={(details) => onOpenChange(details.open)} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          {/* Scrolls on short viewports (landscape phones, 200% zoom) so the button stays reachable. */}
          <Dialog.Content maxW="420px" maxH="calc(100dvh - 32px)" overflowY="auto" p="6">
            {active ? <UpgradeDialogBody prompt={active} onClose={() => onOpenChange(false)} /> : null}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * A primary action the plan doesn't include yet. It stays visible, marked with
 * a gem, and opens the upgrade dialog instead of being disabled.
 */
export function LockedButton({
  prompt,
  children,
  ...rest
}: { prompt: UpgradePrompt; children: ReactNode } & Omit<ButtonProps, "onClick" | "children">) {
  const { openUpgrade } = useUpgrade();
  return (
    <Button {...rest} onClick={() => openUpgrade(prompt)} aria-haspopup="dialog">
      {children}
      <Box as="span" color="upgrade.fg" display="inline-flex">
        <Gem size={13} aria-hidden />
      </Box>
      {prompt.tier ? <chakra.span srOnly>(needs {PLAN_CATALOG[prompt.tier].name})</chakra.span> : null}
    </Button>
  );
}

/** `FeatureHero` for a page the plan doesn't include: a gold call to action
 * that opens the upgrade dialog. */
export function UpgradeHero({
  title,
  points,
  ctaLabel,
  visual,
  prompt,
}: {
  title: string;
  points: string[];
  ctaLabel: string;
  visual: ReactNode;
  prompt: UpgradePrompt;
}) {
  const { openUpgrade, canManageBilling: contextCanManageBilling } = useUpgrade();
  const canManageBilling = prompt.canManageBilling ?? contextCanManageBilling;
  return (
    <FeatureHero
      title={title}
      points={points}
      visual={visual}
      action={
        !prompt.tier ? null : canManageBilling ? (
          <Button size="sm" {...upgradeFill} onClick={() => openUpgrade(prompt)} aria-haspopup="dialog">
            <Gem size={14} aria-hidden />
            {ctaLabel}
          </Button>
        ) : (
          <Text fontSize="13px" color="fg.muted">
            Ask the workspace owner to upgrade to {PLAN_CATALOG[prompt.tier].name}.
          </Text>
        )
      }
    />
  );
}
