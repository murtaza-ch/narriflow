"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import {
  MAX_UPLOAD_LENGTH_SECONDS,
  MONTHLY_PROCESSING_MINUTE_LIMITS,
  PRICING_TABLE,
  workspaceBillingViewSchema,
  type BillingInterval,
  type PaidPricingTier,
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

export function BillingPlans({
  initialView,
  availableTiers,
  isConfigured,
  canManageBilling,
  checkoutReturnSessionId,
  checkoutCancelled,
}: {
  initialView: WorkspaceBillingView;
  availableTiers: PaidPricingTier[];
  isConfigured: boolean;
  canManageBilling: boolean;
  checkoutReturnSessionId: string | null;
  checkoutCancelled: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState(initialView);
  const [interval, setInterval] = useState<BillingInterval>(
    initialView.interval ?? "annual",
  );
  const [busy, setBusy] = useState<string | null>(null);
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
  const mayStartCheckout = canStartBillingCheckout({
    view,
    canManageBilling,
    isConfigured,
  });

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
    };
    if (!response.ok || !payload.url) {
      const actionError = new Error(
        payload.error === "billing_portal_required"
          ? "Manage this plan in the billing portal."
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

  return (
    <Stack gap="7" as="section">
      <Box
        ref={statusRef}
        tabIndex={-1}
        borderRadius="l2"
        bg="bg.panel"
        p="5"
        outline="none"
        role="status"
        aria-live={status.live}
        aria-atomic="true"
      >
        <Flex justify="space-between" align={{ base: "flex-start", md: "center" }} gap="5" direction={{ base: "column", md: "row" }}>
          <Stack gap="1.5" maxW="680px">
            <Flex align="center" gap="2">
              {status.tone === "warning" || status.tone === "danger" ? <CircleAlert size={15} /> : null}
              <Text textStyle="title" fontSize="16px">{status.headline}</Text>
            </Flex>
            <Text fontSize="13px" color="fg.muted">{status.body}</Text>
            {status.dateLabel && status.dateValue ? (
              <Text textStyle="data" fontSize="12px" color="fg.subtle">
                {status.dateLabel} · {status.dateValue}
              </Text>
            ) : null}
          </Stack>
          {primaryAction === "open_portal" ? (
            <Button size="sm" variant="solid" loading={busy === "portal"} disabled={busy !== null} onClick={openPortal}>
              Open billing portal
            </Button>
          ) : primaryAction === "retry" ? (
            <Button size="sm" variant="solid" loading={busy === "retry"} disabled={busy !== null} onClick={retry}>
              <RefreshCw size={14} /> Retry sync
            </Button>
          ) : primaryAction === "contact_support" ? (
            <Button size="sm" variant="solid" asChild><Link href="mailto:support@narriflow.com">Contact support</Link></Button>
          ) : null}
        </Flex>
      </Box>

      {view.plan === "business" ? (
        <Grid layerStyle="band" templateColumns={{ base: "1fr", md: "repeat(2, 1fr)" }} gap="0">
          <Box py="4" pr={{ md: "5" }} borderBottomWidth={{ base: "1px", md: "0" }} borderRightWidth={{ base: "0", md: "1px" }} borderColor="border.subtle">
            <Text textStyle="eyebrow" color="fg.subtle">Additional paid seats</Text>
            <Text textStyle="data" fontSize="24px" mt="1">{view.desiredAdditionalSeats}</Text>
            <Text fontSize="12px" color="fg.muted">Owner seat included. Viewers are free.</Text>
          </Box>
          <Box py="4" pl={{ md: "5" }}>
            <Text textStyle="eyebrow" color="fg.subtle">Synchronized seats</Text>
            <Text textStyle="data" fontSize="24px" mt="1">{view.synchronizedAdditionalSeats ?? "—"}</Text>
            <Text fontSize="12px" color="fg.muted">
              {view.synchronizedAdditionalSeats === view.desiredAdditionalSeats ? "Matches committed membership" : "Updating in the background"}
            </Text>
          </Box>
        </Grid>
      ) : null}

      {mayStartCheckout ? (
        <Stack gap="5">
          <Flex align="center" justify="space-between" gap="3" wrap="wrap">
            <Text textStyle="eyebrow" color="fg.subtle">Choose a plan</Text>
            <SegmentedControl size="sm" aria-label="Billing interval" items={[{ label: "Monthly", value: "monthly" }, { label: "Annual · save ~33%", value: "annual" }]} value={interval} onValueChange={(value) => setInterval(value as BillingInterval)} />
          </Flex>
          <Grid layerStyle="band" templateColumns={{ base: "1fr", md: `repeat(${Math.min(3, availableTiers.length)}, minmax(0, 1fr))` }} gap="3">
            {availableTiers.map((tier) => {
              const info = PRICING_TABLE[tier];
              const perMonth = interval === "annual" ? String(Math.round(info.annualUsd / 12)) : String(info.monthlyUsd);
              return (
                <Stack key={tier} gap="4" p="5" bg="bg.panel" borderRadius="l2">
                  <Text textStyle="eyebrow" color={tier === "creator" ? "accent.fg" : "fg.subtle"}>{tier === "creator" ? "Recommended" : "Plan"}</Text>
                  <Text textStyle="title" fontSize="16px">{info.name}</Text>
                  <Flex align="baseline" gap="1"><Text textStyle="data" fontSize="28px">${perMonth}</Text><Text fontSize="12px" color="fg.muted">/mo</Text></Flex>
                  <Text fontSize="12px" color="fg.muted">{MONTHLY_PROCESSING_MINUTE_LIMITS[tier]} processing min/mo · uploads up to {MAX_UPLOAD_LENGTH_SECONDS[tier] / 60} min</Text>
                  <Button size="sm" variant={tier === "creator" ? "solid" : "outline"} loading={busy === tier} disabled={busy !== null} onClick={() => checkout(tier)}>
                    Continue with {info.name}
                  </Button>
                </Stack>
              );
            })}
          </Grid>
        </Stack>
      ) : null}

      {!canManageBilling ? <Text fontSize="12px" color="fg.subtle">Only the workspace owner can change the subscription or payment method.</Text> : null}
      {inlineError ? <Text role="alert" fontSize="12px" color="danger.fg" tabIndex={-1}>{inlineError}</Text> : null}
      {view.plan !== "business" ? <Text fontSize="13px" color="fg.muted">Business adds shared workspaces, API and MCP access. <Link href="/integrations/mcp" style={{ textDecoration: "underline" }}>Review integration access</Link></Text> : null}
    </Stack>
  );
}
