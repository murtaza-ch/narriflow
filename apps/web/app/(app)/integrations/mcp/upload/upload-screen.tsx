"use client";

import { useSearchParams } from "next/navigation";
import { Stack, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { mcpUploadHandoffQueryOptions } from "@narriflow/api-client/integrations";
import type { IdentityScope } from "@narriflow/api-client/core";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { useApiRuntime, useIdentityScope } from "@/app/_components/api-provider";
import { McpContinuationUnavailable, useContinuationDigest } from "../continuation";
import { McpUploadPicker } from "./upload-picker";
import Loading from "./loading";

export function McpUploadScreen() {
  const token = useSearchParams().get("intent") ?? "";
  const identity = useIdentityScope();
  const result = useContinuationDigest(token);
  if (!token || result?.failed) return <McpContinuationUnavailable kind="upload" />;
  if (!identity || !result) return <Loading />;
  return <UploadView key={`${identity.userId}:${result.digest}`} scope={identity} token={token} digest={result.digest} />;
}

function UploadView({ scope, token, digest }: { scope: IdentityScope; token: string; digest: string }) {
  const { transport } = useApiRuntime();
  const query = useQuery(mcpUploadHandoffQueryOptions({ transport, scope, intent: token, digest }));
  if (query.isError) return <McpContinuationUnavailable kind="upload" error={query.error} />;
  if (!query.data) return <Loading />;
  const { generationContext, recipeName, ...handoff } = query.data;
  return (
    <Stack gap="6" maxW="800px" mx="auto" w="full">
      <PageHeader title="Choose a video for your assistant" description="The assistant's generation settings are committed with this upload. File bytes travel directly to Narriflow storage." />
      {generationContext ? <Text fontSize="13px" color="fg.muted">{generationContext.contentPack.clipCountTarget} clips · {generationContext.contentPack.defaultAspectRatio} · {generationContext.contentPack.clipLengthPreset.replaceAll("_", " ")}</Text> : recipeName ? <Text fontSize="13px" color="fg.muted">Recipe: {recipeName}</Text> : null}
      <McpUploadPicker {...handoff} token={token} generationContext={generationContext} />
    </Stack>
  );
}
