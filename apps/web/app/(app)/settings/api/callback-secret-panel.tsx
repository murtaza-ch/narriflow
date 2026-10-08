"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Copy, RefreshCw, Webhook } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { rotateCallbackSigningSecretAction } from "../actions";
import { authenticatedActionResultMessage, isAuthenticatedActionFailure } from "@/lib/authenticated-request-browser";

// A fixed locale and zone keep server and client renders identical.
const formatTime = (iso: string) =>
  `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso))} UTC`;

export function CallbackSecretPanel({
  status,
  isBusiness,
}: {
  status: { current: { createdAt: string } | null; previousRetiresAt: string | null };
  isBusiness: boolean;
}) {
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function rotate() {
    setError(null);
    startTransition(async () => {
      const result = await rotateCallbackSigningSecretAction();
      if (isAuthenticatedActionFailure(result)) {
        setError(authenticatedActionResultMessage(result, "The signing secret could not be created."));
        return;
      }
      setSecret(result.secret);
      router.refresh();
    });
  }

  return (
    <Box borderTopWidth="1px" borderColor="border" py="6">
      <Stack gap="3">
        <Flex align="center" gap="2"><Webhook size={16} /><Text fontSize="14px" fontWeight="600">Completion callback signing secret</Text></Flex>
        <Text fontSize="13px" lineHeight="1.6" color="fg.muted">
          API requests can include a callback URL. Narriflow signs each completion event with this secret using the Standard Webhooks format. Anyone holding it can verify, and forge, events for this workspace, so give it only to receivers you trust.
        </Text>
        {!isBusiness ? <Text fontSize="13px" color="fg.muted">Completion callbacks require an active Business workspace.</Text> : (
          <Flex gap="3" align={{ base: "start", md: "center" }} direction={{ base: "column", md: "row" }}>
            <Text fontSize="13px" color="fg.subtle" flex="1">
              {status.current ? `Current secret created ${formatTime(status.current.createdAt)}.` : "No signing secret yet. Callback requests are refused until one exists."}
              {status.previousRetiresAt ? ` The previous secret keeps signing until ${formatTime(status.previousRetiresAt)}.` : ""}
            </Text>
            <Button type="button" size="sm" variant="outline" onClick={rotate} disabled={pending}>
              {pending ? <Spinner size="xs" /> : <RefreshCw size={14} />}{status.current ? "Rotate secret" : "Create secret"}
            </Button>
          </Flex>
        )}
        {error ? <Text fontSize="12px" color="danger.fg">{error}</Text> : null}
        {secret ? (
          <Box layerStyle="well" p="4">
            <Text fontSize="13px" fontWeight="600" mb="2">Copy this secret now. It will not be shown again.</Text>
            <Flex gap="2"><Input value={secret} readOnly fontFamily="mono" aria-label="New callback signing secret" /><Button type="button" variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(secret)}><Copy size={14} />Copy</Button></Flex>
          </Box>
        ) : null}
      </Stack>
    </Box>
  );
}
