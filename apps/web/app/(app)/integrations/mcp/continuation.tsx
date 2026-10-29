"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Stack } from "@chakra-ui/react";
import { mcpContinuationDigest } from "@narriflow/api-client/integrations";
import { isApiError } from "@narriflow/api-client/core";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { ConnectorUnavailable, connectorWorkspaceFromError } from "./connector-unavailable";

/** Hash locally before constructing a query: signed tokens never enter cache keys. */
export function useContinuationDigest(token: string) {
  const [result, setResult] = useState<{ token: string; digest: string; failed: boolean } | null>(null);
  useEffect(() => {
    let current = true;
    if (token) {
      void mcpContinuationDigest(token).then(
        (digest) => { if (current) setResult({ token, digest, failed: false }); },
        () => { if (current) setResult({ token, digest: "", failed: true }); },
      );
    }
    return () => { current = false; };
  }, [token]);
  return result?.token === token ? result : null;
}

export function McpContinuationUnavailable({ kind, declined = false, invalidLink = false, error }: { kind: "confirmation" | "upload"; declined?: boolean; invalidLink?: boolean; error?: unknown }) {
  const workspace = connectorWorkspaceFromError(error);
  if (workspace) return <ConnectorUnavailable workspace={workspace} capability={kind === "upload" ? "processing.consume" : "publishing.manage"} action={kind === "upload" ? "Uploading for your assistant" : "Confirming posts from your assistant"} />;
  const confirmation = kind === "confirmation";
  return (
    <Stack gap={declined || invalidLink ? "5" : "4"}>
      <PageHeader
        title={declined ? "Publication declined" : confirmation ? "Confirmation unavailable" : "Upload handoff unavailable"}
        description={declined ? "You declined this confirmation. Any previously confirmed publication is unchanged." : confirmation && invalidLink ? "Ask your assistant to prepare the post again. The confirmation may have expired or workspace access changed." : confirmation ? "Prepare this post again from your assistant. This confirmation may have expired or belong to another account." : "Open the upload tool again from your assistant. This handoff may have expired or belong to another account."}
      />
      <Button asChild variant="subtle"><Link href="/integrations/mcp">Back to MCP integration</Link></Button>
    </Stack>
  );
}

/** Retry the same signed acceptance identity after an uncertain response. */
export function isRetryableContinuationFailure(error: unknown): boolean {
  return isApiError(error) && (error.code === "network_error" || error.status === 429 || error.status >= 500);
}
