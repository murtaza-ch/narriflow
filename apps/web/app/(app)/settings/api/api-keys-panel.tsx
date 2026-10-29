"use client";

import { useMemo, useState } from "react";
import { IconButton, Table, Text } from "@chakra-ui/react";
import type { WorkspaceScope } from "@narriflow/api-client";
import { revokeApiKeyMutation } from "@narriflow/api-client/developer";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, MoreHorizontal, Trash2 } from "lucide-react";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { ActionMenu } from "@narriflow/ui/components/menu";
import { useApiRuntime } from "@/app/_components/api-provider";
import { developerFailureMessage } from "./failure-message";

// A fixed locale and zone keep server and client renders identical.
const formatDate = (iso: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));

const WRITE_LABELS: Record<string, string> = {
  "processing:write": "Clip",
  "exports:write": "Export",
  "autopilot:write": "Autopilot",
  "publishing:write": "Publish",
};

function Access({ scopes }: { scopes: string[] }) {
  const writes = scopes.filter((scope) => scope.endsWith(":write")).map((scope) => WRITE_LABELS[scope] ?? scope);
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
      bg={writes.length ? "accent.subtle" : "bg.soft"}
      color={writes.length ? "accent.fg" : "fg.muted"}
    >
      {writes.length === Object.keys(WRITE_LABELS).length ? "Full access" : writes.length ? `Read + ${writes.join(", ")}` : "Read only"}
    </Text>
  );
}

export function ApiKeysPanel({
  scope,
  keys,
}: {
  /** The Workspace these keys belong to; revoking is bound to it. */
  scope: WorkspaceScope;
  keys: Array<{ id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; createdAt: string }>;
}) {
  const runtime = useApiRuntime();
  const { confirm, dialog } = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const revokeKey = useMutation(useMemo(() => revokeApiKeyMutation(runtime, scope), [runtime, scope]));
  const pending = revokeKey.isPending;

  async function revoke(key: { id: string; name: string }) {
    const confirmed = await confirm({
      title: `Revoke ${key.name}?`,
      description: "Anything using this key stops working right away.",
      confirmLabel: "Revoke key",
      destructive: true,
    });
    if (!confirmed) return;
    setError(null);
    revokeKey.mutate(key.id, {
      onError: (failure) => setError(developerFailureMessage(failure, "The API key could not be revoked.")),
    });
  }

  if (!keys.length) {
    return (
      <EmptyState
        icon={<KeyRound />}
        title="No API keys yet"
        description="Keys let scripts and tools like n8n work in this workspace."
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
            <Table.ColumnHeader {...head}>Name</Table.ColumnHeader>
            <Table.ColumnHeader {...head} display={{ base: "none", md: "table-cell" }}>
              Key
            </Table.ColumnHeader>
            <Table.ColumnHeader {...head}>Access</Table.ColumnHeader>
            <Table.ColumnHeader {...head} display={{ base: "none", sm: "table-cell" }}>
              Last used
            </Table.ColumnHeader>
            <Table.ColumnHeader {...head} display={{ base: "none", lg: "table-cell" }}>
              Created
            </Table.ColumnHeader>
            <Table.ColumnHeader {...head} w="12">
              <Text srOnly>Actions</Text>
            </Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {keys.map((key) => (
            <Table.Row
              key={key.id}
              bg="bg.subtle"
              css={{ "& > td:first-of-type": { borderStartRadius: "10px" }, "& > td:last-of-type": { borderEndRadius: "10px" } }}
            >
              <Table.Cell {...cell} fontWeight="500">
                {key.name}
              </Table.Cell>
              <Table.Cell {...cell} display={{ base: "none", md: "table-cell" }} fontFamily="mono" fontSize="12px" color="fg.muted">
                {key.prefix}••••
              </Table.Cell>
              <Table.Cell {...cell}>
                <Access scopes={key.scopes} />
              </Table.Cell>
              <Table.Cell {...cell} display={{ base: "none", sm: "table-cell" }} color="fg.muted">
                {key.lastUsedAt ? formatDate(key.lastUsedAt) : "Never"}
              </Table.Cell>
              <Table.Cell {...cell} display={{ base: "none", lg: "table-cell" }} color="fg.muted">
                {formatDate(key.createdAt)}
              </Table.Cell>
              <Table.Cell {...cell} py="1.5" textAlign="end">
                <ActionMenu
                  ariaLabel={`${key.name} actions`}
                  trigger={
                    <IconButton size="sm" variant="ghost" color="fg.muted" aria-label={`${key.name} actions`} disabled={pending}>
                      <MoreHorizontal size={16} />
                    </IconButton>
                  }
                  items={[
                    {
                      value: "revoke",
                      label: "Revoke key",
                      icon: <Trash2 size={14} />,
                      destructive: true,
                      onSelect: () => void revoke(key),
                    },
                  ]}
                />
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {error ? (
        <Text fontSize="13px" color="danger.fg">
          {error}
        </Text>
      ) : null}
      {dialog}
    </>
  );
}
