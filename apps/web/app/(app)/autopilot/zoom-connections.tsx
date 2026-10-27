"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import type { ZoomConnectionSnapshot } from "@narriflow/validators";
import { LockedButton, type UpgradePrompt } from "../_components/upgrade";

export function ZoomConnections({ connections, canConnect, askToConnect = false, connectUpgrade = null, notice }: { connections: ZoomConnectionSnapshot[]; canConnect: boolean; /** The role, not the Workspace state, is what stops this member connecting. */ askToConnect?: boolean; /** Set when the plan doesn't run Autopilot: connecting opens the upgrade dialog instead. */ connectUpgrade?: UpgradePrompt | null; notice?: string }) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function disconnect(connection: ZoomConnectionSnapshot) {
    if (!await confirm({ title: "Disconnect Zoom?", description: "Rules using this Zoom connection will pause. Existing projects are kept.", confirmLabel: "Disconnect", destructive: true })) return;
    setPending(connection.id);
    setError(null);
    try {
      const response = await fetch(`/api/zoom/connections/${connection.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      router.refresh();
    } catch { setError("Zoom could not be disconnected. Try again."); }
    finally { setPending(null); }
  }
  return (
    <Box as="section" borderWidth="1px" borderColor="border.card" borderRadius="l3" p={{ base: "4", md: "5" }}>
      <Flex direction={{ base: "column", md: "row" }} align={{ base: "stretch", md: "center" }} gap="4" justify="space-between">
        <Stack gap="1">
          <Text as="h2" fontSize="14px" fontWeight="600">Zoom recordings</Text>
          <Text fontSize="13px" color="fg.muted">Connect Zoom, then add a rule to clip future cloud recordings with a Recipe.</Text>
        </Stack>
        {canConnect && connectUpgrade ? <LockedButton variant="subtle" size="sm" prompt={connectUpgrade}>Connect Zoom</LockedButton> : canConnect ? <Button asChild variant="subtle" size="sm"><a href="/api/zoom/oauth/start">Connect Zoom</a></Button> : askToConnect ? <Text fontSize="13px" color="fg.muted">Ask a workspace editor or admin to connect Zoom.</Text> : null}
      </Flex>
      {notice ? <Text role="status" mt="3" fontSize="13px" color={notice === "connected" ? "success.fg" : "danger.fg"}>{notice === "connected" ? "Zoom connected. Create a rule, or resume the rules you paused." : "Zoom could not be connected. Try connecting again."}</Text> : null}
      {connections.length > 0 ? <Stack mt="4" gap="3">
        {connections.map((connection) => <Flex key={connection.id} align="center" justify="space-between" gap="3" wrap="wrap">
          <Text fontSize="13px">{connection.displayName}<Text as="span" color="fg.muted">{connection.revoked ? " • Reconnect to restore access" : " • Connected"}</Text></Text>
          {!connection.revoked && connection.canDisconnect ? <Button size="xs" variant="ghost" loading={pending === connection.id} disabled={pending !== null && pending !== connection.id} onClick={() => void disconnect(connection)}>Disconnect</Button> : null}
        </Flex>)}
      </Stack> : null}
      {error ? <Text role="alert" mt="3" color="danger.fg" fontSize="13px">{error}</Text> : null}
      {dialog}
    </Box>
  );
}
