"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { Spinner } from "@narriflow/ui/components/spinner";
import { createApiKeyAction, revokeApiKeyAction } from "../actions";
import type { WorkspaceApiKeyScope } from "@narriflow/validators";
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";
import { resolveWorkspaceApiKeyScopes } from "./api-key-scope-selection";

const readScopeOptions: ReadonlyArray<{
  scope: WorkspaceApiKeyScope;
  label: string;
  detail: string;
}> = [
  {
    scope: "publishing:read",
    label: "Publication recovery",
    detail: "Inspect existing social publication attempts and outcomes.",
  },
  {
    scope: "brand:read",
    label: "Brand profiles",
    detail: "Read brand identity, voice, and owned asset metadata.",
  },
  {
    scope: "review:read",
    label: "Review status",
    detail: "Read round, approval, and notification status without guest secrets.",
  },
];

const mutationScopeOptions: ReadonlyArray<{
  scope: WorkspaceApiKeyScope;
  label: string;
  detail: string;
}> = [
  {
    scope: "autopilot:write",
    label: "RSS autopilot",
    detail: "Create rules and mark existing rules due.",
  },
  {
    scope: "publishing:write",
    label: "Publication recovery",
    detail: "Confirm, recheck, or explicitly republish uncertain attempts.",
  },
  {
    scope: "campaign:operate",
    label: "Campaign operations",
    detail: "Run revision-fenced actions on explicitly selected clips.",
  },
  {
    scope: "review:write",
    label: "Review delivery",
    detail: "Create idempotent review rounds and queue notifications.",
  },
  {
    scope: "publishing:prepare",
    label: "Publishing preparation",
    detail: "Generate copy, extract thumbnails, and schedule approved batches.",
  },
  {
    scope: "generated-media:submit",
    label: "Generated media",
    detail: "Submit high-level generation jobs and read their status.",
  },
];

export function ApiKeysPanel({
  keys,
  isBusiness,
}: {
  keys: Array<{ id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; createdAt: string }>;
  isBusiness: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<Set<WorkspaceApiKeyScope>>(
    () => new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createApiKeyAction({
        name,
        scopes: resolveWorkspaceApiKeyScopes(selectedScopes),
      });
      if (!result.ok) {
        return setError(authenticatedActionResultMessage(result, "The API key could not be created."));
      }
      setName("");
      setSecret(result.key.secret);
      router.refresh();
    });
  }

  function toggleScope(scope: WorkspaceApiKeyScope, checked: boolean) {
    setSelectedScopes((current) => {
      const next = new Set(current);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
  }

  function revoke(keyId: string) {
    startTransition(async () => {
      const result = await revokeApiKeyAction(keyId);
      if (isAuthenticatedActionFailure(result)) {
        setError(
          authenticatedActionResultMessage(
            result,
            "The API key could not be revoked.",
          ),
        );
        return;
      }
      router.refresh();
    });
  }

  return (
    <Stack gap="8">
      <Box as="form" onSubmit={create} borderTopWidth="1px" borderColor="border" py="6">
        <Stack gap="3">
          <Flex align="center" gap="2"><KeyRound size={16} /><Text fontSize="14px" fontWeight="600">Create workspace API key</Text></Flex>
          <Text fontSize="13px" lineHeight="1.6" color="fg.muted">
            Keys are workspace-bound credentials for unattended API or MCP clients. Personal OAuth connections are managed by each member in their AI client.
          </Text>
          {!isBusiness ? <Text fontSize="13px" color="fg.muted">API key creation requires an active Business workspace. Upgrade from Subscription, or review the MCP guide before upgrading.</Text> : (
            <Stack gap="3">
              <Flex gap="3" direction={{ base: "column", md: "row" }}><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Key name, e.g. Claude Desktop" maxLength={80} required /><Button type="submit" size="sm" disabled={pending}>{pending ? <Spinner size="xs" /> : <Plus size={14} />}Create key</Button></Flex>
              <Box borderTopWidth="1px" borderColor="border.subtle" pt="4">
                <Text textStyle="eyebrow" color="fg.subtle" mb="2">
                  Included by default
                </Text>
                <Text fontSize="12px" color="fg.muted" lineHeight="1.6">
                  Projects, exports, usage, and RSS autopilot are read-only. Add only the access this client needs.
                </Text>
              </Box>
              <Flex gap="6" direction={{ base: "column", lg: "row" }} align="start">
                <Stack gap="3" flex="1" width="full">
                  <Text textStyle="eyebrow" color="fg.subtle">Additional reads</Text>
                  {readScopeOptions.map((option) => (
                    <Checkbox
                      key={option.scope}
                      checked={selectedScopes.has(option.scope)}
                      onCheckedChange={(checked) => toggleScope(option.scope, checked)}
                    >
                      <Stack gap="0.5">
                        <Text fontSize="13px" fontWeight="550">{option.label}</Text>
                        <Text fontSize="11px" color="fg.subtle" lineHeight="1.45">{option.detail}</Text>
                      </Stack>
                    </Checkbox>
                  ))}
                </Stack>
                <Stack gap="3" flex="1" width="full">
                  <Text textStyle="eyebrow" color="fg.subtle">Mutations</Text>
                  {mutationScopeOptions.map((option) => (
                    <Checkbox
                      key={option.scope}
                      checked={selectedScopes.has(option.scope)}
                      onCheckedChange={(checked) => toggleScope(option.scope, checked)}
                    >
                      <Stack gap="0.5">
                        <Text fontSize="13px" fontWeight="550">{option.label}</Text>
                        <Text fontSize="11px" color="fg.subtle" lineHeight="1.45">{option.detail}</Text>
                      </Stack>
                    </Checkbox>
                  ))}
                  <Box borderTopWidth="1px" borderColor="border.subtle" pt="2">
                    <Text fontSize="11px" color="fg.disabled" lineHeight="1.45">
                      Brand write is reserved for a future version; no public brand mutation is available yet.
                    </Text>
                  </Box>
                </Stack>
              </Flex>
            </Stack>
          )}
          {error ? <Text fontSize="12px" color="danger.fg">{error}</Text> : null}
          {secret ? (
            <Box layerStyle="well" p="4">
              <Text fontSize="13px" fontWeight="600" mb="2">Copy this secret now. It will not be shown again.</Text>
              <Flex gap="2"><Input value={secret} readOnly fontFamily="mono" /><Button type="button" variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(secret)}><Copy size={14} />Copy</Button></Flex>
            </Box>
          ) : null}
        </Stack>
      </Box>
      <Stack gap="0" borderTopWidth="1px" borderColor="border">
        <Text textStyle="eyebrow" color="fg.subtle" py="3">Active keys · {keys.length}</Text>
        {keys.length === 0 ? <Text py="6" fontSize="13px" color="fg.muted">No API keys in this workspace.</Text> : keys.map((key) => (
          <Flex key={key.id} align="center" gap="3" py="4" borderTopWidth="1px" borderColor="border.subtle">
            <Stack gap="1" flex="1"><Text fontSize="13px" fontWeight="550">{key.name}</Text><Text fontSize="12px" color="fg.subtle" fontFamily="mono">{key.prefix}•••• · {key.lastUsedAt ? `last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : "no recorded use"}</Text><Text fontSize="12px" color="fg.subtle" lineHeight="1.5">{key.scopes.join(" · ")}</Text></Stack>
            <Button size="xs" variant="ghost" aria-label={`Revoke ${key.name}`} onClick={() => revoke(key.id)} disabled={pending}><Trash2 size={14} /></Button>
          </Flex>
        ))}
      </Stack>
    </Stack>
  );
}
