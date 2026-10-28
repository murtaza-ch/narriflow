"use client";

import { useActionState, useEffect } from "react";
import { Box, Flex, Stack, Text, chakra } from "@chakra-ui/react";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { formatUsdCents, PLAN_CATALOG } from "@narriflow/validators";
import { createBusinessWorkspaceAction, type CreateWorkspaceState } from "./actions";

const INITIAL_STATE: CreateWorkspaceState = {};

const { monthlyPriceCents, annualPriceCents } = PLAN_CATALOG.business;
const ANNUAL_SAVING_PERCENT = Math.round((1 - annualPriceCents / (monthlyPriceCents * 12)) * 100);

const INCLUDED = [
  "The owner seat",
  `${PLAN_CATALOG.business.limits.monthlyCredits.toLocaleString("en-US")} shared credits a month`,
  "Extra Admins and Editors, billed per seat",
];

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState(createBusinessWorkspaceAction, INITIAL_STATE);

  useEffect(() => {
    if (state.checkoutUrl) window.location.assign(state.checkoutUrl);
  }, [state.checkoutUrl]);

  return (
    <chakra.form action={action}>
      <Stack gap="6">
        <Stack gap="1.5">
          <Label htmlFor="workspace-name">Workspace name</Label>
          <Input
            key={`${state.requestId ?? "initial"}:${state.workspaceName ?? ""}`}
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
            key={`${state.requestId ?? "initial"}:${state.interval ?? "annual"}`}
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

        {state.error ? (
          <Box role="alert" bg="danger.subtle" borderRadius="l2" px="4" py="3">
            <Text fontSize="13px" color="danger.fg">{state.error}</Text>
            {state.workspaceId ? (
              <Text fontSize="12px" color="fg.subtle" mt="1">
                Your pending workspace was preserved. Submit again to retry checkout.
              </Text>
            ) : null}
            {state.requestId ? (
              <Text fontSize="12px" color="fg.subtle" mt="1">
                Support ID: {state.requestId}
              </Text>
            ) : null}
          </Box>
        ) : null}

        <Stack gap="3">
          <Button type="submit" size="md" h="11" w="full" loading={pending} disabled={Boolean(state.checkoutUrl)}>
            Continue to secure checkout
            <ArrowRight size={16} />
          </Button>
          <Text fontSize="12px" color="fg.subtle" textAlign="center">
            The workspace stays read-only until Stripe confirms payment.
          </Text>
        </Stack>
      </Stack>
    </chakra.form>
  );
}
