"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { CalendarClock, Check, CircleAlert, Clock, CreditCard, RefreshCw, Users } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Dialog, Portal } from "@narriflow/ui/components/dialog";
import {
  formatUsdCents,
  hasFeature,
  lowestTierWithFeature,
  minimumAnnualSavingsPercent,
  PLAN_CATALOG,
  planHighlights,
  planChangeQuoteSchema,
  planChangeResultSchema,
  workspaceBillingViewSchema,
  type BillingInterval,
  type PaidPricingTier,
  type PlanChangeQuote,
  type WorkspaceBillingView,
} from "@narriflow/validators";
import {
  clearCheckoutKey,
  getOrCreateCheckoutKey,
  pollBillingActivation,
  waitForBillingPoll,
} from "@/lib/billing-browser";
import {
  billingStatusPresentation,
  canStartBillingCheckout,
  shouldFocusBillingStatus,
} from "@/lib/billing-view-model";
import {
  canChangePaidPlan,
  formatBillingChangeDate,
  planChangeQuotePresentation,
  stripeInvoicePaymentUrl,
} from "@/lib/billing-plan-change";
import { IconTile, SettingRow, SettingsCard, StatusPill } from "../_components/settings-ui";

const STATUS_PILL: Record<"accent" | "warning" | "danger", { tone: "accent" | "warning" | "danger"; label: string }> = {
  accent: { tone: "accent", label: "Updating" },
  warning: { tone: "warning", label: "Needs attention" },
  danger: { tone: "danger", label: "Action needed" },
};

/** A notice about a plan change in flight: icon, what is happening, and its actions. */
function ChangeNotice({ icon, children, actions }: { icon: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Flex gap="4" align={{ base: "flex-start", md: "center" }} justify="space-between" direction={{ base: "column", md: "row" }} p={{ base: "5", md: "6" }} bg="bg.subtle" borderRadius="l3">
      <Flex gap="3" align="flex-start" minW="0">
        <IconTile tone="accent">{icon}</IconTile>
        <Box minW="0">{children}</Box>
      </Flex>
      {actions}
    </Flex>
  );
}

export function BillingPlans({
  initialView,
  availableTiers,
  isConfigured,
  canManageBilling,
  checkoutReturnSessionId,
  checkoutCancelled,
  focusTier = null,
  requestedInterval = null,
}: {
  initialView: WorkspaceBillingView;
  availableTiers: PaidPricingTier[];
  isConfigured: boolean;
  canManageBilling: boolean;
  checkoutReturnSessionId: string | null;
  checkoutCancelled: boolean;
  /** The plan an upgrade prompt sent the user here for; its card leads. */
  focusTier?: PaidPricingTier | null;
  /** The interval the upgrade prompt showed. */
  requestedInterval?: BillingInterval | null;
}) {
  const router = useRouter();
  const [view, setView] = useState(initialView);
  const [interval, setInterval] = useState<BillingInterval>(
    requestedInterval ?? initialView.interval ?? "annual",
  );
  // A prompt can send the user to this same route with a different ?interval=,
  // which re-renders this component instead of mounting it.
  const [seenRequestedInterval, setSeenRequestedInterval] = useState(requestedInterval);
  if (requestedInterval !== seenRequestedInterval) {
    setSeenRequestedInterval(requestedInterval);
    if (requestedInterval) setInterval(requestedInterval);
  }
  const leadTier = focusTier && availableTiers.includes(focusTier) ? focusTier : "pro";
  const [busy, setBusy] = useState<string | null>(null);
  const [quote, setQuote] = useState<PlanChangeQuote | null>(null);
  const [inlineNotice, setInlineNotice] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(
    checkoutCancelled
      ? "Checkout was cancelled. Your plan is unchanged, and you can continue safely when ready."
      : null,
  );
  const statusRef = useRef<HTMLDivElement>(null);
  const actionOriginRef = useRef<HTMLElement | null>(null);
  const startedReturnObservation = useRef(false);
  const previousStatus = useRef({
    health: initialView.health,
    workspaceAccessStatus: initialView.workspaceAccessStatus,
  });
  const status = billingStatusPresentation(view);
  const quotePresentation = quote
    ? planChangeQuotePresentation(quote, view.planChange?.state === "scheduled" ? view.planChange : null)
    : null;
  const mayStartCheckout = canStartBillingCheckout({
    view,
    canManageBilling,
    isConfigured,
  });
  const mayChangePlan = canChangePaidPlan({ view, canManageBilling, isConfigured });

  useEffect(() => setView(initialView), [initialView]);

  function rememberActionOrigin() {
    actionOriginRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  function restoreActionOriginAfterError() {
    requestAnimationFrame(() => actionOriginRef.current?.focus());
  }

  const readBillingState = useCallback(async () => {
    const response = await fetch("/api/billing/state", { cache: "no-store" });
    const payload = (await response.json()) as { view?: unknown };
    if (!response.ok || !payload.view) throw new Error("Billing status is unavailable");
    const nextView = workspaceBillingViewSchema.parse(payload.view);
    const retryAfterSeconds = Number(response.headers.get("Retry-After") ?? 0) || undefined;
    setView(nextView);
    return { view: nextView, retryAfterSeconds };
  }, []);

  const pollUntilSettled = useCallback(async (signal: AbortSignal) => {
    const result = await pollBillingActivation({
      read: readBillingState,
      wait: waitForBillingPoll,
      signal,
    });
    setView(result.view);
  }, [readBillingState]);

  useEffect(() => {
    if (startedReturnObservation.current) return;
    if (!checkoutReturnSessionId && initialView.health !== "activating") return;
    startedReturnObservation.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        if (checkoutReturnSessionId) {
          const response = await fetch("/api/billing/checkout/return", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: checkoutReturnSessionId }),
            signal: controller.signal,
          });
          const payload = (await response.json()) as {
            kind?: "activating" | "terminal";
            reason?: "expired";
            view?: unknown;
          };
          if (!response.ok || !payload.view) {
            throw new Error("Checkout could not be verified. You can retry safely.");
          }
          setView(workspaceBillingViewSchema.parse(payload.view));
          router.replace("/settings/billing", { scroll: false });
          if (payload.kind === "terminal") {
            setInlineError(
              "This Checkout session expired. Your plan is unchanged, and you can retry safely.",
            );
            return;
          }
        }
        await pollUntilSettled(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          setInlineError(
            error instanceof Error ? error.message : "Billing status is unavailable",
          );
        }
      }
    })();
    return () => controller.abort();
  }, [checkoutReturnSessionId, initialView.health, pollUntilSettled, router]);

  useEffect(() => {
    if (checkoutCancelled) router.replace("/settings/billing", { scroll: false });
  }, [checkoutCancelled, router]);

  useEffect(() => {
    if (shouldFocusBillingStatus(previousStatus.current, view)) {
      statusRef.current?.focus();
    }
    previousStatus.current = {
      health: view.health,
      workspaceAccessStatus: view.workspaceAccessStatus,
    };
  }, [view]);

  async function postForUrl(url: string, body?: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      url?: string;
      error?: string;
      message?: string;
    };
    if (!response.ok || !payload.url) {
      const actionError = new Error(
        payload.error === "billing_portal_required"
          ? "This workspace already has a subscription. Manage it in the billing portal."
          : payload.error === "checkout_in_progress"
            ? "A Checkout for a different plan is already open for this workspace. Finish it, or wait about 30 minutes for it to expire, then try again."
            : "The billing action could not be opened. Try again.",
      );
      Object.assign(actionError, { code: payload.error });
      throw actionError;
    }
    return payload.url;
  }

  async function checkout(tier: PaidPricingTier) {
    rememberActionOrigin();
    setBusy(tier);
    setInlineError(null);
    try {
      const clientIdempotencyKey = getOrCreateCheckoutKey({
        storage: window.localStorage,
        workspaceId: view.workspaceId,
        tier,
        interval,
        createKey: () => crypto.randomUUID(),
      });
      window.location.assign(
        await postForUrl("/api/billing/checkout", {
          clientIdempotencyKey,
          tier,
          interval,
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "checkout_attempt_terminal"
      ) {
        clearCheckoutKey({
          storage: window.localStorage,
          workspaceId: view.workspaceId,
          tier,
          interval,
        });
      }
      setInlineError(
        error instanceof Error && "code" in error && error.code === "checkout_attempt_terminal"
          ? "The previous Checkout expired. Try again to start a fresh, safe Checkout."
          : error instanceof Error
            ? error.message
            : "Checkout could not be started",
      );
      setBusy(null);
      restoreActionOriginAfterError();
    }
  }

  async function openPortal() {
    rememberActionOrigin();
    setBusy("portal");
    setInlineError(null);
    try {
      window.location.assign(await postForUrl("/api/billing/portal"));
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : "The billing portal is unavailable",
      );
      setBusy(null);
      restoreActionOriginAfterError();
    }
  }

  async function postPlanChange(path: string, body?: unknown) {
    const response = await fetch(`/api/billing/plan-change/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messages: Record<string, string> = {
        plan_change_invalid: "Choose a different plan or billing interval.",
        plan_change_quote_expired: "This quote expired. Close it and review the plan again for a fresh price.",
        plan_change_conflict: "Billing changed while this quote was open. Close it and review the plan again.",
        plan_change_busy: "Another billing change is in progress. Wait a moment, then review the plan again.",
        plan_change_recovery_required: "Review the current payment, cancellation or pending plan change in billing before starting another change.",
        plan_change_not_configured: "Plan changes are temporarily unavailable. Your current plan is unchanged.",
        plan_change_schedule_conflict: "This subscription has a scheduled change that needs support before it can be updated.",
        plan_change_quote_missing: "This quote is no longer available. Close it and review the plan again.",
        billing_forbidden: "Only the workspace owner can change the subscription.",
      };
      throw new Error(messages[payload.error] ?? "The plan change could not be completed. Refresh billing status and try again.");
    }
    return payload;
  }

  async function previewPlanChange(tier: PaidPricingTier) {
    rememberActionOrigin();
    setBusy(tier);
    setInlineError(null);
    setInlineNotice(null);
    try {
      const result = await postPlanChange("preview", {
        clientIdempotencyKey: crypto.randomUUID(),
        tier,
        interval,
      });
      setQuote(planChangeQuoteSchema.parse(result.quote));
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "The plan could not be reviewed.");
      restoreActionOriginAfterError();
    } finally {
      setBusy(null);
    }
  }

  async function refreshAfterPlanChange() {
    try {
      const response = await fetch("/api/billing/reconcile", { method: "POST" });
      const payload = await response.json();
      if (!response.ok || !payload.view) throw new Error("Billing sync is delayed");
      setView(workspaceBillingViewSchema.parse(payload.view));
      router.refresh();
    } catch {
      setInlineNotice("Your billing request was submitted. Refresh billing status to check the verified result before making another change.");
    }
  }

  async function confirmPlanChange() {
    if (!quote) return;
    setBusy("confirm");
    setInlineError(null);
    try {
      const result = planChangeResultSchema.parse(await postPlanChange("confirm", { quoteId: quote.id }));
      setQuote(null);
      if (result.kind === "pending_payment") {
        if (result.paymentUrl) {
          const paymentUrl = stripeInvoicePaymentUrl(result.paymentUrl);
          if (paymentUrl) {
            window.location.assign(paymentUrl);
            return;
          }
        }
        setInlineNotice("Your current plan remains active. Use Complete payment below to finish the upgrade.");
      } else if (result.kind === "scheduled" && result.effectiveAt) {
        setInlineNotice(`Your plan change is scheduled for ${formatBillingChangeDate(result.effectiveAt)} UTC. Your current plan stays active until then.`);
      } else {
        setInlineNotice("Stripe accepted your plan change. Narriflow is verifying the updated subscription.");
      }
      await refreshAfterPlanChange();
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "The plan could not be changed.");
    } finally {
      setBusy(null);
    }
  }

  async function keepCurrentPlan() {
    rememberActionOrigin();
    setBusy("cancel-change");
    setInlineError(null);
    setInlineNotice(null);
    try {
      const pending = view.planChange?.state === "pending_payment";
      planChangeResultSchema.parse(await postPlanChange("cancel"));
      // The view may be stale (the upgrade could have been paid in another tab),
      // so say what was asked and let the refreshed status show the outcome.
      setInlineNotice(pending
        ? "Keeping your current plan. Any unpaid upgrade is cancelled; the status above is up to date."
        : "The scheduled plan change was removed. Your current plan will continue.");
      await refreshAfterPlanChange();
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "The scheduled change could not be removed.");
      restoreActionOriginAfterError();
    } finally {
      setBusy(null);
    }
  }

  /** Opens Stripe's hosted invoice for the upgrade that is awaiting payment. */
  async function completePlanChangePayment() {
    rememberActionOrigin();
    setBusy("complete-payment");
    setInlineError(null);
    try {
      const { url } = (await postPlanChange("payment")) as { url?: string | null };
      const paymentUrl = url ? stripeInvoicePaymentUrl(url) : null;
      if (!paymentUrl) throw new Error("This upgrade no longer needs payment. Refresh billing status to see the current plan.");
      window.location.assign(paymentUrl);
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "The payment page could not be opened.");
      setBusy(null);
      restoreActionOriginAfterError();
    }
  }

  async function retry() {
    rememberActionOrigin();
    setBusy("retry");
    setInlineError(null);
    try {
      const response = await fetch("/api/billing/reconcile", { method: "POST" });
      const payload = (await response.json()) as { view?: unknown };
      if (!response.ok || !payload.view) throw new Error("Billing sync is still delayed");
      const nextView = workspaceBillingViewSchema.parse(payload.view);
      setView(nextView);
      if (nextView.health === "activating" || nextView.health === "retrying") {
        await pollUntilSettled(new AbortController().signal);
      }
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : "Billing sync is unavailable",
      );
      restoreActionOriginAfterError();
    } finally {
      setBusy(null);
    }
  }

  const primaryAction = canManageBilling ? status.primaryAction : null;

  const pill = status.tone !== "neutral" ? STATUS_PILL[status.tone] : view.health === "current" ? { tone: "accent" as const, label: "Up to date" } : null;

  return (
    <Stack gap="6" as="section">
      <Box
        ref={statusRef}
        tabIndex={-1}
        borderRadius="l3"
        bg="bg.subtle"
        p={{ base: "5", md: "6" }}
        outline="none"
        role="status"
        aria-live={status.live}
        aria-atomic="true"
      >
        <Flex justify="space-between" align={{ base: "flex-start", md: "center" }} gap="5" direction={{ base: "column", md: "row" }}>
          <Flex gap="3" align="flex-start" minW="0">
            <IconTile tone={status.tone === "neutral" ? "neutral" : "accent"}>
              {status.tone === "warning" || status.tone === "danger" ? <CircleAlert size={16} /> : <CreditCard size={16} />}
            </IconTile>
            <Stack gap="1.5" maxW="680px" minW="0">
              <Flex align="center" gap="2.5" wrap="wrap">
                <Text as="h2" fontSize="15px" fontWeight="500">{status.headline}</Text>
                {pill ? <StatusPill tone={pill.tone}>{pill.label}</StatusPill> : null}
              </Flex>
              <Text fontSize="13px" color="fg.muted">{status.body}</Text>
              {status.dateLabel && status.dateValue ? (
                <Flex align="center" gap="1.5" fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums">
                  <CalendarClock size={12} aria-hidden />
                  {status.dateLabel} · {status.dateValue}
                </Flex>
              ) : null}
            </Stack>
          </Flex>
          {primaryAction === "open_portal" ? (
            <Button size="sm" variant="solid" flexShrink={0} loading={busy === "portal"} disabled={busy !== null} onClick={openPortal}>
              Open billing portal
            </Button>
          ) : primaryAction === "retry" ? (
            <Button size="sm" variant="solid" flexShrink={0} loading={busy === "retry"} disabled={busy !== null} onClick={retry}>
              <RefreshCw size={14} /> Retry sync
            </Button>
          ) : primaryAction === "contact_support" ? (
            <Button size="sm" variant="solid" flexShrink={0} asChild><Link href="mailto:support@narriflow.com">Contact support</Link></Button>
          ) : null}
        </Flex>
      </Box>

      {view.plan === "business" ? (
        <SettingsCard icon={<Users size={16} />} title="Seats" description="Admins and Editors are billed per seat.">
          <Stack gap="1">
            <SettingRow
              title="Additional paid seats"
              description="Owner seat included. Viewers are free."
              control={<Text fontSize="20px" fontWeight="550" fontVariantNumeric="tabular-nums">{view.desiredAdditionalSeats}</Text>}
            />
            <SettingRow
              title="Seats on the subscription"
              description={view.synchronizedAdditionalSeats === view.desiredAdditionalSeats ? "Matches your team" : "Updating in the background"}
              control={<Text fontSize="20px" fontWeight="550" fontVariantNumeric="tabular-nums">{view.synchronizedAdditionalSeats ?? "—"}</Text>}
            />
          </Stack>
        </SettingsCard>
      ) : null}

      {view.planChange?.state === "scheduled" ? (
        <ChangeNotice
          icon={<CalendarClock size={16} />}
          actions={canManageBilling ? <Button size="sm" variant="subtle" flexShrink={0} loading={busy === "cancel-change"} disabled={busy !== null} onClick={keepCurrentPlan}>Keep current plan</Button> : null}
        >
          <Text fontSize="15px" fontWeight="500">Switching to {PLAN_CATALOG[view.planChange.tier].name}</Text>
          <Text fontSize="13px" color="fg.muted" mt="1">
            {view.planChange.effectiveAt ? `Your current plan stays active until ${formatBillingChangeDate(view.planChange.effectiveAt)} UTC.` : "Your current plan stays active until renewal."}
            {" "}To cancel your subscription in the billing portal, remove this scheduled change first.
          </Text>
        </ChangeNotice>
      ) : view.planChange?.state === "pending_payment" ? (
        <ChangeNotice
          icon={<Clock size={16} />}
          actions={canManageBilling ? (
            <Flex gap="2" flexShrink={0}>
              <Button size="sm" variant="subtle" loading={busy === "cancel-change"} disabled={busy !== null} onClick={keepCurrentPlan}>Keep current plan</Button>
              <Button size="sm" variant="solid" loading={busy === "complete-payment"} disabled={busy !== null} onClick={completePlanChangePayment}>Complete payment</Button>
            </Flex>
          ) : null}
        >
          <Stack gap="1" role="status">
            <Text fontSize="15px" fontWeight="500">Upgrade to {PLAN_CATALOG[view.planChange.tier].name} is awaiting payment</Text>
            <Text fontSize="13px" color="fg.muted">
              Your current plan stays active. {canManageBilling ? "Finish paying to switch now, or keep your current plan. Unpaid upgrades are cancelled automatically within a day." : "The workspace owner can finish the payment or keep the current plan."}
            </Text>
          </Stack>
        </ChangeNotice>
      ) : null}

      {mayStartCheckout || mayChangePlan ? (
        <Stack id="plans" gap="4" scrollMarginTop="24px" pt="2">
          <Flex align="center" justify="space-between" gap="3" wrap="wrap">
            <Text as="h2" fontSize="15px" fontWeight="500">{mayStartCheckout ? "Choose a plan" : "Change plan"}</Text>
            <SegmentedControl size="sm" aria-label="Billing interval" items={[{ label: "Monthly", value: "monthly" }, { label: `Annual · save ${minimumAnnualSavingsPercent()}%+`, value: "annual" }]} value={interval} onValueChange={(value) => setInterval(value as BillingInterval)} />
          </Flex>
          <Grid templateColumns={{ base: "1fr", md: `repeat(${Math.min(3, availableTiers.length)}, minmax(0, 1fr))` }} gap="3">
            {availableTiers.map((tier) => {
              const info = PLAN_CATALOG[tier];
              const isCurrentPlan = !mayStartCheckout && tier === view.plan && interval === view.interval;
              // The workspace's own plan, on either interval.
              const isOwnTier = !mayStartCheckout && tier === view.plan;
              const perMonth = formatUsdCents(
                interval === "annual" ? Math.round(info.annualPriceCents / 12) : info.monthlyPriceCents,
              );
              const highlighted = tier === focusTier;
              return (
                <Stack
                  key={tier}
                  gap="5"
                  p="6"
                  bg={highlighted ? "accent.subtle" : "bg.subtle"}
                  borderRadius="l3"
                  outline="2px solid"
                  outlineColor={isOwnTier || highlighted ? "accent.solid" : "transparent"}
                  outlineOffset="-2px"
                >
                  <Flex align="center" justify="space-between" gap="2" minH="6">
                    <Text as="h3" textStyle="title" fontSize="17px">{info.name}</Text>
                    <Flex gap="1.5" wrap="wrap" justify="flex-end">
                      {isOwnTier ? <PlanChip>{isCurrentPlan ? "Your plan" : `Your plan · ${view.interval === "annual" ? "annual" : "monthly"}`}</PlanChip> : null}
                      {highlighted ? <PlanChip>Selected</PlanChip> : tier === "pro" ? <PlanChip>Recommended</PlanChip> : null}
                    </Flex>
                  </Flex>
                  <Stack gap="1">
                    <Flex align="baseline" gap="1">
                      <Text fontWeight="550" fontVariantNumeric="tabular-nums" fontSize="34px" lineHeight="1" letterSpacing="-0.02em">{perMonth}</Text>
                      <Text fontSize="13px" color="fg.muted">/mo</Text>
                    </Flex>
                    <Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums">
                      {interval === "annual" ? `${formatUsdCents(info.annualPriceCents)} billed yearly` : "Billed monthly"}
                    </Text>
                  </Stack>
                  <Stack as="ul" gap="2.5" listStyleType="none" flex="1">
                    {planHighlights(tier).map((highlight) => (
                      <Flex as="li" key={highlight} gap="2.5" align="flex-start" fontSize="13px" color="fg.muted">
                        <Box color="accent.fg" mt="0.5" flexShrink={0}><Check size={14} aria-hidden /></Box>
                        <Text as="span">{highlight}</Text>
                      </Flex>
                    ))}
                  </Stack>
                  <Button size="md" w="full" variant={tier === leadTier ? "solid" : "subtle"} loading={busy === tier} disabled={busy !== null || isCurrentPlan} onClick={() => mayStartCheckout ? checkout(tier) : previewPlanChange(tier)}>
                    {mayStartCheckout ? `Continue with ${info.name}` : isCurrentPlan ? "Current plan" : `Review ${info.name}`}
                  </Button>
                </Stack>
              );
            })}
          </Grid>
        </Stack>
      ) : null}

      {!canManageBilling ? <Text fontSize="12px" color="fg.subtle">Only the workspace owner can change the subscription or payment method.</Text> : null}
      {canManageBilling && !isConfigured ? <Text fontSize="12px" color="fg.subtle">Plan changes are temporarily unavailable. Try again later.</Text> : null}
      {inlineNotice ? <Text role="status" fontSize="13px" color="fg.muted">{inlineNotice}</Text> : null}
      {inlineError && !quote ? <Text role="alert" fontSize="12px" color="danger.fg" tabIndex={-1}>{inlineError}</Text> : null}
      <Dialog.Root open={quote !== null} onOpenChange={({ open }) => { if (!open && busy !== "confirm") setQuote(null); }} placement="center" closeOnEscape={busy !== "confirm"} closeOnInteractOutside={busy !== "confirm"} finalFocusEl={() => actionOriginRef.current}>
        <Portal><Dialog.Backdrop /><Dialog.Positioner p="4"><Dialog.Content maxW="460px" maxH="calc(100dvh - 32px)" overflowY="auto" bg="bg.panel" p="6">
          {quote && quotePresentation ? <Stack gap="5">
            <Dialog.Title fontSize="20px">{quotePresentation.title}</Dialog.Title>
            <Dialog.Description fontSize="13px" color="fg.muted">{quotePresentation.body}</Dialog.Description>
            <Box bg="bg.soft" p="4" borderRadius="l2">
              <Flex justify="space-between" gap="3"><Text fontSize="13px">Due today</Text><Text fontWeight="500" fontVariantNumeric="tabular-nums">{quotePresentation.due}</Text></Flex>
              <Text fontSize="12px" color="fg.muted" mt="2">{PLAN_CATALOG[quote.tier].name} · {quote.interval === "annual" ? `${formatUsdCents(PLAN_CATALOG[quote.tier].annualPriceCents)} billed yearly` : `${formatUsdCents(PLAN_CATALOG[quote.tier].monthlyPriceCents)} billed monthly`}, plus additional seats and applicable taxes.</Text>
              <Text fontSize="12px" color="fg.subtle" mt="2">Monthly processing credits keep their usual renewal date. Current usage is retained.</Text>
            </Box>
            {inlineError ? <Text role="alert" fontSize="12px" color="danger.fg">{inlineError}</Text> : null}
            <Flex justify="flex-end" gap="2" wrap="wrap">
              <Button size="sm" variant="subtle" disabled={busy === "confirm"} onClick={() => setQuote(null)}>Cancel</Button>
              <Button size="sm" variant="solid" loading={busy === "confirm"} disabled={busy !== null} onClick={confirmPlanChange}>{quotePresentation.action}</Button>
            </Flex>
          </Stack> : null}
        </Dialog.Content></Dialog.Positioner></Portal>
      </Dialog.Root>
      {!hasFeature(view.plan, "integrations.api") ? (
        <Text fontSize="13px" color="fg.muted">
          {PLAN_CATALOG[lowestTierWithFeature("integrations.api") ?? "pro"].name} adds the REST API, MCP and webhooks; Business adds team members and client review.{" "}
          <Link href="/pricing" style={{ textDecoration: "underline" }}>Compare plans</Link>
        </Text>
      ) : !hasFeature(view.plan, "workspace.members") ? (
        <Text fontSize="13px" color="fg.muted">
          Business adds team members, shared brand approval, and client review rooms.{" "}
          <Link href="/pricing" style={{ textDecoration: "underline" }}>Compare plans</Link>
        </Text>
      ) : null}
    </Stack>
  );
}

/** A small label on a plan card: whose plan it is, or which one to pick. */
function PlanChip({ children }: { children: React.ReactNode }) {
  return (
    <Text as="span" display="inline-flex" alignItems="center" h="6" px="2.5" borderRadius="full" bg="accent.muted" color="accent.fg" fontSize="12px" fontWeight="500" whiteSpace="nowrap">
      {children}
    </Text>
  );
}
