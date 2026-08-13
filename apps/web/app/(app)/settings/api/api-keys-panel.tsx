"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { Spinner } from "@narriflow/ui/components/spinner";
import { createApiKeyAction, revokeApiKeyAction } from "../actions";

export function ApiKeysPanel({
  keys,
  isBusiness,
  mcpUrl,
}: {
  keys: Array<{ id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; createdAt: string }>;
  isBusiness: boolean;
  mcpUrl: string;
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
      if (!result.ok) return setError(result.error);
      setName("");
      setSecret(result.key.secret);
      router.refresh();
    });
  }

  function revoke(keyId: string) {
    startTransition(async () => {
      await revokeApiKeyAction(keyId);
      router.refresh();
    });
  }

  return (
    <Stack gap="8">
      <Box borderTopWidth="1px" borderColor="border" py="6">
        <Stack gap="3">
          <Text textStyle="eyebrow" color="fg.subtle">Remote MCP server</Text>
          <Text fontSize="13px" color="fg.muted">
            Connect Codex, Claude, or another Streamable HTTP client with OAuth. For unattended clients, use a key below as the bearer token.
          </Text>
          <Flex gap="2"><Input value={mcpUrl} readOnly fontFamily="mono" /><Button type="button" variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(mcpUrl)}><Copy size={14} />Copy URL</Button></Flex>
          <Text fontSize="11px" color="fg.subtle" fontFamily="mono">Codex config.toml · [mcp_servers.narriflow] url = &quot;{mcpUrl}&quot;</Text>
          <Text fontSize="11px" color="fg.subtle" fontFamily="mono">claude mcp add --transport http narriflow {mcpUrl}</Text>
        </Stack>
      </Box>
      <Box as="form" onSubmit={create} borderTopWidth="1px" borderColor="border" py="6">
        <Stack gap="3">
          <Flex align="center" gap="2"><KeyRound size={16} /><Text fontSize="13px" fontWeight="600">Create workspace key</Text></Flex>
          {!isBusiness ? <Text fontSize="12px" color="fg.muted">API access is available on Business workspaces.</Text> : (
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
              <Text fontSize="12px" fontWeight="600" mb="2">Copy this secret now. It will not be shown again.</Text>
              <Flex gap="2"><Input value={secret} readOnly fontFamily="mono" /><Button type="button" variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(secret)}><Copy size={14} />Copy</Button></Flex>
            </Box>
          ) : null}
        </Stack>
      </Box>
      <Stack gap="0" borderTopWidth="1px" borderColor="border">
        <Text textStyle="eyebrow" color="fg.subtle" py="3">Active keys · {keys.length}</Text>
        {keys.length === 0 ? <Text py="6" fontSize="13px" color="fg.muted">No API keys in this workspace.</Text> : keys.map((key) => (
          <Flex key={key.id} align="center" gap="3" py="4" borderTopWidth="1px" borderColor="border.subtle">
            <Stack gap="0" flex="1"><Text fontSize="13px" fontWeight="550">{key.name}</Text><Text fontSize="11px" color="fg.subtle" fontFamily="mono">{key.prefix}•••• · {key.lastUsedAt ? `used ${new Date(key.lastUsedAt).toLocaleDateString()}` : "never used"}</Text><Text fontSize="11px" color="fg.subtle">{key.scopes.join(" · ")}</Text></Stack>
            <Button size="xs" variant="ghost" aria-label={`Revoke ${key.name}`} onClick={() => revoke(key.id)} disabled={pending}><Trash2 size={14} /></Button>
          </Flex>
        ))}
      </Stack>
    </Stack>
  );
}
