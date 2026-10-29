"use client";

import { useMemo, useState } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { isApiError } from "@narriflow/api-client";
import { startBusinessWorkspaceCheckout } from "@narriflow/api-client/billing";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import {
  businessWorkspaceCheckoutRecoverySchema,
  type BusinessWorkspaceCheckoutRequest,
} from "@narriflow/validators/api/billing";
import { formatUsdCents, PLAN_CATALOG } from "@narriflow/validators";
import { useMutation } from "@tanstack/react-query";
import { useApiRuntime, useIdentityScope } from "@/app/_components/api-provider";
import {
  apiErrorMessage,
  apiErrorSupportId,
  QueryMutationForm,
} from "@/app/_components/query-mutation-form";
import {
  buildBusinessWorkspaceCheckoutRequest,
  type PreservedWorkspaceCheckoutState,
  recoverBusinessWorkspaceCheckoutFields,
} from "./checkout-request";

const SIGNED_OUT = { userId: "" };

const { monthlyPriceCents, annualPriceCents } = PLAN_CATALOG.business;
const ANNUAL_SAVING_PERCENT = Math.round((1 - annualPriceCents / (monthlyPriceCents * 12)) * 100);

const INCLUDED = [
  "The owner seat",
  `${PLAN_CATALOG.business.limits.monthlyCredits.toLocaleString("en-US")} shared credits a month`,
  "Extra Admins and Editors, billed per seat",
];

export function CreateWorkspaceForm() {
  const runtime = useApiRuntime();
  const identity = useIdentityScope() ?? SIGNED_OUT;
  // What a failed attempt keeps for the retry: the pending Workspace that already
  // exists and the checkout key, so a retry resumes it instead of creating another.
  const [state, setState] = useState<PreservedWorkspaceCheckoutState>({});
  const [failures, setFailures] = useState(0);
  const [redirecting, setRedirecting] = useState(false);

  // One key per submission, kept through a lost response: the retry resumes the same pending Workspace.
  const intent = useMemo(() => runtime.createIntent<BusinessWorkspaceCheckoutRequest>(), [runtime]);
  const checkout = useMutation({
    mutationFn: (input: BusinessWorkspaceCheckoutRequest) =>
      startBusinessWorkspaceCheckout(runtime.transport, identity, input, intent.keyFor(input)),
    onSuccess: (started) => {
      intent.complete();
      // The new Workspace becomes the explicit selection before the person leaves for Stripe.
      // Checkout proves nothing about entitlement: Billing observes the verified state on return.
      runtime.selectWorkspace(started.selection.workspaceId);
      setRedirecting(true);
      window.location.assign(started.checkoutUrl);
    },
    onError: (error, input) => {
      const recovery = isApiError(error)
        ? businessWorkspaceCheckoutRecoverySchema.safeParse(error.details?.recovery)
        : null;
      setState((previous) => ({
        ...previous,
        ...recoverBusinessWorkspaceCheckoutFields(previous, input),
        ...(recovery?.success ? recovery.data : {}),
      }));
      setFailures((count) => count + 1);
    },
  });
  const pending = checkout.isPending;
  const message = checkout.error
    ? apiErrorMessage(checkout.error, "Workspace checkout could not be started")
    : null;
  const supportId = checkout.error ? apiErrorSupportId(checkout.error) : null;
  const formKey = useMemo(() => `${failures}:${state.workspaceName ?? ""}`, [failures, state.workspaceName]);

  return (
    <QueryMutationForm
      mutation={checkout}
      hideError
      // The API validates the strict request schema; a bad value comes back as `invalid_input`.
      toVariables={(formData) =>
        buildBusinessWorkspaceCheckoutRequest(state, formData) as BusinessWorkspaceCheckoutRequest
      }
    >
      <Stack gap="6">
        <Stack gap="1.5">
          <Label htmlFor="workspace-name">Workspace name</Label>
          <Input
            key={formKey}
            id="workspace-name"
            name="name"
            size="md"
            h="11"
            autoComplete="organization"
            placeholder="Acme content team"
            defaultValue={state.workspaceName}
            minLength={1}
            maxLength={80}
            required={!state.workspaceId}
            disabled={Boolean(state.workspaceId) || pending}
          />
          {state.workspaceId && state.workspaceName ? (
            <input type="hidden" name="name" value={state.workspaceName} />
          ) : null}
        </Stack>

        <Stack gap="3">
          <Label id="workspace-interval-label">Billing</Label>
          <SegmentedControl
            key={`${formKey}:${state.interval ?? "annual"}`}
            name="interval"
            aria-labelledby="workspace-interval-label"
            w="full"
            size="md"
            css={{ "& [data-part='item']": { flex: "1", justifyContent: "center" } }}
            defaultValue={state.interval ?? "annual"}
            disabled={Boolean(state.workspaceId) || pending}
            items={[
              {
                value: "annual",
                label: (
                  <Flex align="center" justify="center" gap="2" w="full">
                    Annual
                    <Text as="span" fontSize="12px" color="fg.subtle">
                      {formatUsdCents(annualPriceCents)}/year
                    </Text>
                  </Flex>
                ),
              },
              {
                value: "monthly",
                label: (
                  <Flex align="center" justify="center" gap="2" w="full">
                    Monthly
                    <Text as="span" fontSize="12px" color="fg.subtle">
                      {formatUsdCents(monthlyPriceCents)}/month
                    </Text>
                  </Flex>
                ),
              },
            ]}
          />
          {state.workspaceId && state.interval ? (
            <input type="hidden" name="interval" value={state.interval} />
          ) : null}
          <Text fontSize="12px" color="fg.subtle">
            Annual billing saves {ANNUAL_SAVING_PERCENT}%.
          </Text>
          <Stack as="ul" gap="1.5" listStyleType="none" p="4" bg="bg.soft" borderRadius="l2">
            {INCLUDED.map((item) => (
              <Flex as="li" key={item} align="center" gap="2" fontSize="13px" color="fg.muted">
                <Box color="accent.fg" flexShrink={0}>
                  <Check size={14} aria-hidden />
                </Box>
                {item}
              </Flex>
            ))}
          </Stack>
        </Stack>

        {message ? (
          <Box role="alert" bg="danger.subtle" borderRadius="l2" px="4" py="3">
            <Text fontSize="13px" color="danger.fg">{message}</Text>
            {state.workspaceId ? (
              <Text fontSize="12px" color="fg.subtle" mt="1">
                Your pending workspace was preserved. Submit again to retry checkout.
              </Text>
            ) : null}
            {supportId ? (
              <Text fontSize="12px" color="fg.subtle" mt="1">
                Support ID: {supportId}
              </Text>
            ) : null}
          </Box>
        ) : null}

        <Stack gap="3">
          <Button type="submit" size="md" h="11" w="full" loading={pending} disabled={redirecting}>
            Continue to secure checkout
            <ArrowRight size={16} />
          </Button>
          <Text fontSize="12px" color="fg.subtle" textAlign="center">
            The workspace stays read-only until Stripe confirms payment.
          </Text>
        </Stack>
      </Stack>
    </QueryMutationForm>
  );
}
