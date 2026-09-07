"use client";

import { useActionState, useEffect } from "react";
import { Box, Input, Stack, Text, chakra } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Select } from "@narriflow/ui/components/select";
import { createBusinessWorkspaceAction, type CreateWorkspaceState } from "./actions";

const INITIAL_STATE: CreateWorkspaceState = {};

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState(createBusinessWorkspaceAction, INITIAL_STATE);

  useEffect(() => {
    if (state.checkoutUrl) window.location.assign(state.checkoutUrl);
  }, [state.checkoutUrl]);

  return (
    <chakra.form action={action} maxW="560px">
      <Stack gap="5" bg="bg.dialog" borderWidth="1px" borderColor="border" borderRadius="l3" p="6">
        <Stack gap="2">
          <chakra.label htmlFor="workspace-name" fontSize="13px" fontWeight="600">
            Workspace name
          </chakra.label>
          <Input
            key={`${state.requestId ?? "initial"}:${state.workspaceName ?? ""}`}
            id="workspace-name"
            name="name"
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
          <Text fontSize="12px" color="fg.subtle">
            Each Business workspace has its own projects, members, usage, and subscription.
          </Text>
        </Stack>

        <Stack gap="2">
          <chakra.label htmlFor="workspace-interval" fontSize="13px" fontWeight="600">
            Billing interval
          </chakra.label>
          <Select
            key={`${state.requestId ?? "initial"}:${state.interval ?? "annual"}`}
            id="workspace-interval"
            name="interval"
            defaultValue={state.interval ?? "annual"}
            ariaLabel="Billing interval"
            disabled={Boolean(state.workspaceId) || pending}
            items={[
              { value: "annual", label: "Annual — $312/year" },
              { value: "monthly", label: "Monthly — $39/month" },
            ]}
          />
          {state.workspaceId && state.interval ? (
            <input type="hidden" name="interval" value={state.interval} />
          ) : null}
          <Text fontSize="12px" color="fg.subtle">
            Includes the owner seat and 1,800 shared processing minutes. Additional Admins and Editors are billed per seat.
          </Text>
        </Stack>

        {state.error ? (
          <Box role="alert" layerStyle="well" borderLeftWidth="3px" borderLeftColor="danger.solid" px="4" py="3">
            <Text fontSize="13px" color="danger.fg">{state.error}</Text>
            {state.workspaceId ? (
              <Text fontSize="12px" color="fg.subtle" mt="1">
                Your pending workspace was preserved. Submit again to retry checkout.
              </Text>
            ) : null}
            {state.requestId ? (
              <Text fontSize="11px" color="fg.subtle" mt="1">
                Support ID: {state.requestId}
              </Text>
            ) : null}
          </Box>
        ) : null}

        <Button type="submit" alignSelf="flex-start" loading={pending} disabled={Boolean(state.checkoutUrl)}>
          Continue to secure checkout
        </Button>
        <Text fontSize="11px" color="fg.subtle">
          The workspace remains read-only until Stripe confirms payment.
        </Text>
      </Stack>
    </chakra.form>
  );
}
