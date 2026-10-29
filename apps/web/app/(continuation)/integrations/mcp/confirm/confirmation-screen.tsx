"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { invalidateAfterMcpConfirmation, mcpConfirmationMutationOptions, mcpPreparationQueryOptions } from "@narriflow/api-client/integrations";
import type { ApiError, IdentityScope } from "@narriflow/api-client/core";
import type { McpConfirmationInput } from "@narriflow/validators/api/integrations";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { useApiRuntime, useIdentityScope } from "@/app/_components/api-provider";
import { ApiErrorNotice } from "@/app/_components/query-mutation-form";
import { isRetryableContinuationFailure, McpContinuationUnavailable, useContinuationDigest } from "@/app/(app)/integrations/mcp/continuation";
import Loading from "./loading";

export function McpConfirmationScreen() {
  const search = useSearchParams();
  const token = search.get("token") ?? "";
  const declined = Boolean(search.get("declined"));
  const unavailable = declined || Boolean(search.get("failure")) || !token;
  const identity = useIdentityScope();
  const result = useContinuationDigest(unavailable ? "" : token);
  if (unavailable || result?.failed) return <McpContinuationUnavailable kind="confirmation" declined={declined} invalidLink={unavailable} />;
  if (!identity || !result) return <Loading />;
  return <ConfirmationView key={`${identity.userId}:${result.digest}`} scope={identity} token={token} digest={result.digest} />;
}

function ConfirmationView({ scope, token, digest }: { scope: IdentityScope; token: string; digest: string }) {
  const runtime = useApiRuntime();
  const router = useRouter();
  const query = useQuery({ ...mcpPreparationQueryOptions({ transport: runtime.transport, scope, token, digest }), refetchOnWindowFocus: false, refetchOnReconnect: false });
  const { mutationFn: confirm, retry } = mcpConfirmationMutationOptions({ transport: runtime.transport, scope });
  const [uncertainConfirmation, setUncertainConfirmation] = useState(false);
  const mutation = useMutation<{ destination: string }, ApiError, McpConfirmationInput["decision"]>({
    retry,
    gcTime: 0,
    // Only the decision enters mutation state; the signed token stays in this closure.
    mutationFn: (decision: McpConfirmationInput["decision"], context) => confirm!({ token, decision }, context),
    onError: (error, decision) => {
      if (decision === "confirm" && isRetryableContinuationFailure(error)) setUncertainConfirmation(true);
    },
    onSuccess: async ({ destination }, decision) => {
      if (decision === "confirm" && query.data) {
        await invalidateAfterMcpConfirmation(runtime.queryClient, { ...scope, workspaceId: query.data.workspaceId });
      }
      if (runtime.scope.isCurrent({ ...scope, workspaceId: null })) router.push(destination);
    },
  });
  if (query.isError && !query.data) return <McpContinuationUnavailable kind="confirmation" error={query.error} />;
  if (mutation.isError && !isRetryableContinuationFailure(mutation.error)) return <McpContinuationUnavailable kind="confirmation" error={mutation.error} />;
  if (!query.data) return <Loading />;
  const { intent, workspaceName, destinationAccount, expiresAt } = query.data;
  const facts = [["Workspace", workspaceName], ["Destination account", destinationAccount], ["Platform", intent.platform], ["Clip", intent.clipId], ["Editor revision", String(intent.expectedEditorRevision)], ["Export", intent.clipExportId], ["Export variant", intent.clipExportVariantId], ["Output format", `${intent.aspectRatio} · ${intent.resolution}`], ["Scheduled time", intent.scheduledFor], ["Delivery mode", intent.deliveryMode ?? "Direct publication"]];
  return (
    <Stack gap="6" maxW="800px" mx="auto" w="full">
      <PageHeader title="Confirm this exact publication" description="Review the frozen clip revision, destination and caption. Narriflow checks review approval again before scheduling." />
      <Stack as="dl" gap="3">{facts.map(([label, value]) => <Flex key={label} gap="4" direction={{ base: "column", md: "row" }}><Text as="dt" minW="160px" fontWeight="500">{label}</Text><Text as="dd" fontSize="13px" overflowWrap="anywhere">{value}</Text></Flex>)}</Stack>
      <Stack gap="2"><Text as="h2" fontSize="16px" fontWeight="500">Caption</Text><Text whiteSpace="pre-wrap">{intent.caption}</Text></Stack>
      <Stack gap="2"><Text as="h2" fontSize="16px" fontWeight="500">Provider settings</Text><Text as="pre" fontFamily="mono" fontSize="12px" whiteSpace="pre-wrap" overflowWrap="anywhere">{JSON.stringify(intent.providerSettings, null, 2)}</Text></Stack>
      <Button asChild variant="subtle"><Link href={`/projects/${intent.projectId}`}>Review in Narriflow</Link></Button>
      <Stack gap="3">
        <Text fontSize="13px" color="fg.muted">Confirmation expires at {expiresAt}.</Text>
        <Flex gap="3">
          <Button type="button" disabled={mutation.isPending || mutation.isSuccess} loading={mutation.isPending && mutation.variables === "confirm"} onClick={() => mutation.mutate("confirm")}>{uncertainConfirmation ? "Try again" : "Confirm and schedule"}</Button>
          <Button type="button" disabled={mutation.isPending || mutation.isSuccess || uncertainConfirmation} loading={mutation.isPending && mutation.variables === "decline"} onClick={() => mutation.mutate("decline")} variant="subtle">Decline</Button>
        </Flex>
        {uncertainConfirmation ? <Text fontSize="13px" color="fg.muted">Scheduling may have succeeded. Try again to check the same publication.</Text> : null}
        {mutation.isError ? <ApiErrorNotice error={mutation.error} fallback="Confirmation could not be completed. Try again." /> : null}
      </Stack>
    </Stack>
  );
}
