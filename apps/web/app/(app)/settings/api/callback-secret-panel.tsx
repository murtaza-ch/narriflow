"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { RefreshCw, Webhook } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { CodeBlock } from "@narriflow/ui/components/code-block";
import { Spinner } from "@narriflow/ui/components/spinner";
import { authenticatedActionResultMessage, isAuthenticatedActionFailure } from "@/lib/authenticated-request-browser";
import { rotateCallbackSigningSecretAction } from "../actions";

// A fixed locale and zone keep server and client renders identical.
const formatTime = (iso: string) =>
  `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso))} UTC`;

export function CallbackSecretPanel({
  status,
}: {
  status: { current: { createdAt: string } | null; previousRetiresAt: string | null };
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
    <Stack gap="3" bg="bg.subtle" borderRadius="12px" p="4">
      <Flex align={{ base: "flex-start", sm: "center" }} gap="3" direction={{ base: "column", sm: "row" }}>
        <Flex gap="3" align="center" flex="1" minW="0">
          <Flex boxSize="9" borderRadius="10px" bg="bg.soft" color="fg" align="center" justify="center" flexShrink={0}>
            <Webhook size={18} />
          </Flex>
          <Stack gap="0" minW="0">
            <Text fontSize="14px" fontWeight="500">
              Callback signing secret
            </Text>
            <Text fontSize="13px" color="fg.muted">
              {status.current ? `Created ${formatTime(status.current.createdAt)}` : "Not created. Requests with a callback URL are refused until it exists."}
              {status.previousRetiresAt ? `. The previous secret signs until ${formatTime(status.previousRetiresAt)}.` : ""}
            </Text>
          </Stack>
        </Flex>
        <Button type="button" size="sm" variant="subtle" onClick={rotate} disabled={pending} flexShrink={0}>
          {pending ? <Spinner size="xs" /> : <RefreshCw size={16} />}
          {status.current ? "Rotate secret" : "Create secret"}
        </Button>
      </Flex>
      {secret ? (
        <Stack gap="2">
          <Text fontSize="13px" color="fg.muted">
            Copy it now. You won't see it again.
          </Text>
          <CodeBlock code={secret} copyLabel="Copy secret" />
        </Stack>
      ) : null}
      {error ? (
        <Text fontSize="13px" color="danger.fg">
          {error}
        </Text>
      ) : null}
    </Stack>
  );
}
