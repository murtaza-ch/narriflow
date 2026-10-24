"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconButton, Table, Text } from "@chakra-ui/react";
import { MoreHorizontal, Play, RotateCcw, Trash2, Webhook } from "lucide-react";
import type { WebhookDisabledReason, WebhookView } from "@narriflow/validators";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { ActionMenu } from "@narriflow/ui/components/menu";
import { authenticatedActionResultMessage, isAuthenticatedActionFailure } from "@/lib/authenticated-request-browser";
import { deleteWebhookAction, enableWebhookAction, testWebhookAction } from "../actions";
import { EVENT_LABELS } from "./add-webhook-dialog";

// A fixed locale and zone keep server and client renders identical.
const formatTime = (iso: string) =>
  `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso))} UTC`;

const DISABLED_TEXT: Record<WebhookDisabledReason, string> = {
  consecutive_failures: "Paused after 20 failed deliveries",
  cursor_expired: "Paused: delivery fell more than 30 days behind",
  endpoint_gone: "Paused: the endpoint answered 410 Gone",
};

function Status({ webhook }: { webhook: WebhookView }) {
  const paused = webhook.status === "disabled";
  return (
    <Text
      as="span"
      display="inline-flex"
      alignItems="center"
      h="22px"
      px="2"
      borderRadius="6px"
      fontSize="12px"
      whiteSpace="nowrap"
      bg={paused ? "warning.subtle" : "bg.soft"}
      color={paused ? "warning.fg" : "fg.muted"}
    >
      {paused ? "Paused" : webhook.consecutiveFailures > 0 ? `Retrying (${webhook.consecutiveFailures})` : "Active"}
    </Text>
  );
}

function delivery(webhook: WebhookView) {
  if (webhook.status === "disabled" && webhook.disabledReason) return DISABLED_TEXT[webhook.disabledReason];
  if (webhook.consecutiveFailures > 0) {
    return webhook.lastResponseStatus ? `Last attempt answered ${webhook.lastResponseStatus}` : "Last attempt got no response";
  }
  return webhook.lastDeliveredAt ? `Delivered ${formatTime(webhook.lastDeliveredAt)}` : "Nothing delivered yet";
}

const failed = (result: unknown) =>
  isAuthenticatedActionFailure(result) || (typeof result === "object" && result !== null && "ok" in result && result.ok === false);

export function WebhooksPanel({ webhooks }: { webhooks: WebhookView[] }) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [message, setMessage] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [pending, startTransition] = useTransition();

  function run<R>(task: () => Promise<R>, fallback: string, report?: (result: R) => string | null) {
    setMessage(null);
    startTransition(async () => {
      const result = await task();
      if (failed(result)) setMessage({ text: authenticatedActionResultMessage(result, fallback), tone: "error" });
      else {
        const text = report?.(result);
        if (text) setMessage({ text, tone: "info" });
      }
      router.refresh();
    });
  }

  async function remove(webhook: WebhookView) {
    const confirmed = await confirm({
      title: `Delete the webhook for ${webhook.urlHost}?`,
      description: "It stops receiving events right away.",
      confirmLabel: "Delete webhook",
      destructive: true,
    });
    if (confirmed) run(() => deleteWebhookAction(webhook.webhookId), "The webhook could not be deleted.");
  }

  if (!webhooks.length) {
    return (
      <EmptyState
        icon={<Webhook />}
        title="No webhooks yet"
        description="Webhooks push finished work to your tools as signed events, in order."
      />
    );
  }

  const cell = { border: "0", py: "3", px: "3", fontSize: "13px" } as const;
  const head = { border: "0", px: "3", pt: "0", pb: "1", fontSize: "12px", fontWeight: "400", color: "fg.subtle" } as const;

  return (
    <>
      <Table.Root size="sm" css={{ borderCollapse: "separate", borderSpacing: "0 4px", marginTop: "-4px" }}>
        <Table.Header>
          <Table.Row bg="transparent">
            <Table.ColumnHeader {...head}>Endpoint</Table.ColumnHeader>
            <Table.ColumnHeader {...head} display={{ base: "none", md: "table-cell" }}>
              Events
            </Table.ColumnHeader>
            <Table.ColumnHeader {...head}>Status</Table.ColumnHeader>
            <Table.ColumnHeader {...head} display={{ base: "none", sm: "table-cell" }}>
              Delivery
            </Table.ColumnHeader>
            <Table.ColumnHeader {...head} w="12">
              <Text srOnly>Actions</Text>
            </Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {webhooks.map((webhook) => (
            <Table.Row
              key={webhook.webhookId}
              bg="bg.subtle"
              css={{ "& > td:first-of-type": { borderStartRadius: "10px" }, "& > td:last-of-type": { borderEndRadius: "10px" } }}
            >
              <Table.Cell {...cell} fontWeight="500">
                {webhook.urlHost}
              </Table.Cell>
              <Table.Cell {...cell} display={{ base: "none", md: "table-cell" }} color="fg.muted">
                {webhook.types.map((type) => EVENT_LABELS[type].label).join(", ")}
              </Table.Cell>
              <Table.Cell {...cell}>
                <Status webhook={webhook} />
              </Table.Cell>
              <Table.Cell {...cell} display={{ base: "none", sm: "table-cell" }} color="fg.muted">
                {delivery(webhook)}
              </Table.Cell>
              <Table.Cell {...cell} py="1.5" textAlign="end">
                <ActionMenu
                  ariaLabel={`${webhook.urlHost} actions`}
                  trigger={
                    <IconButton size="sm" variant="ghost" color="fg.muted" aria-label={`${webhook.urlHost} actions`} disabled={pending}>
                      <MoreHorizontal size={16} />
                    </IconButton>
                  }
                  items={[
                    ...(webhook.status === "disabled"
                      ? [
                          {
                            value: "enable",
                            label: "Re-enable",
                            icon: <RotateCcw size={14} />,
                            onSelect: () => run(() => enableWebhookAction(webhook.webhookId), "The webhook could not be re-enabled."),
                          },
                        ]
                      : []),
                    {
                      value: "test",
                      label: "Send test event",
                      icon: <Play size={14} />,
                      onSelect: () =>
                        run(() => testWebhookAction(webhook.webhookId), "The test event could not be sent.", (result) =>
                          "status" in result ? (result.status ? `${webhook.urlHost} answered ${result.status}.` : `${webhook.urlHost} did not answer.`) : null,
                        ),
                    },
                    {
                      value: "delete",
                      label: "Delete webhook",
                      icon: <Trash2 size={14} />,
                      destructive: true,
                      onSelect: () => void remove(webhook),
                    },
                  ]}
                />
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {message ? (
        <Text fontSize="13px" color={message.tone === "error" ? "danger.fg" : "fg.muted"}>
          {message.text}
        </Text>
      ) : null}
      {dialog}
    </>
  );
}
