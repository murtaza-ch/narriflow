"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { Spinner } from "@narriflow/ui/components/spinner";
import { createApiKeyAction, revokeApiKeyAction } from "../actions";
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

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
  const [allowAutopilotWrites, setAllowAutopilotWrites] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createApiKeyAction({
        name,
        scopes: [
          "projects:read",
          "exports:read",
          "usage:read",
          "autopilot:read",
          ...(allowAutopilotWrites ? ["autopilot:write"] : []),
        ],
      });
      if (!result.ok) {
        return setError(authenticatedActionResultMessage(result, "The API key could not be created."));
      }
      setName("");
      setSecret(result.key.secret);
      router.refresh();
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
              <Checkbox checked={allowAutopilotWrites} onCheckedChange={setAllowAutopilotWrites}>
                Allow this key to create and run RSS autopilot rules
              </Checkbox>
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
