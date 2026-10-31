"use client";

import { Box, HStack, Stack, Text } from "@chakra-ui/react";
import { createProjectsClient, clearProjectAccess, projectQueries } from "@narriflow/api-client/projects";
import { useProgressStream } from "@narriflow/api-client/progress";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { userErrorMessage } from "@narriflow/validators";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useApiRuntime } from "@/app/_components/api-provider";
import { useIntake } from "../_lib/intake-context";
import { deriveImportProgress } from "../_lib/import-progress";

/** Initial imports finish here; only a complete, playable batch opens the results. */
export function ImportProgress({ projectId }: { projectId: string }) {
  const router = useRouter();
  const runtime = useApiRuntime();
  const { scope, transport } = useIntake();
  const [streamHealthy, setStreamHealthy] = useState(false);
  const client = useMemo(() => createProjectsClient(transport.scoped(scope)), [transport, scope]);
  const detail = useQuery({
    ...projectQueries.detail(client, scope, projectId),
    // A fresh read also covers a refresh with a cached, previously completed project.
    refetchOnMount: "always",
    refetchInterval: (query) => streamHealthy || (query.state.data && deriveImportProgress(query.state.data).state !== "processing") ? false : 5_000,
  });
  const progress = detail.data ? deriveImportProgress(detail.data) : null;
  const reread = () => { void clearProjectAccess(runtime.queryClient, scope, projectId); };
  useProgressStream(runtime, scope, projectId, {
    enabled: !progress || progress.state === "processing",
    sinceSeq: detail.data?.snapshot.lastSeq ?? 0,
    onStatus: (status) => setStreamHealthy(status.state === "open"),
    onRevoked: reread,
    onFatal: reread,
  });
  useEffect(() => {
    if (progress?.state === "ready" && !detail.isFetching && !detail.isError) {
      router.replace(`/projects/${projectId}`);
    }
  }, [progress?.state, detail.isFetching, detail.isError, projectId, router]);

  const failed = progress?.state === "failed";
  return (
    <Stack data-import-progress gap="5" maxW="640px" mx="auto" py={{ base: "8", md: "16" }}>
      <Text fontSize="13px" color="fg.muted" truncate>{detail.data?.snapshot.project?.title}</Text>
      <HStack gap="3" role="status" aria-live="polite">
        {!failed && !detail.isError ? <Spinner size="sm" color="accent.fg" /> : null}
        <Text textStyle="title" fontSize="22px">{detail.isError ? "Could not check clip progress" : progress?.label ?? "Loading your import"}</Text>
      </HStack>
      {!failed && !detail.isError ? (
        <>
          <Box role="progressbar" aria-label={progress?.label ?? "Clip generation"} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={progress?.progress ?? undefined} h="4px" bg="bg.muted" borderRadius="full" overflow="hidden">
            <Box h="full" bg="accent.solid" w={progress?.progress != null ? `${progress.progress}%` : "35%"}
              animation={progress?.progress == null ? "pulse" : undefined} transition="width 600ms ease" />
          </Box>
          <Text color="fg.muted" fontSize="14px">
            {progress && progress.totalCount > 0 ? `${progress.readyCount} of ${progress.totalCount} clips ready. ` : ""}
            Your results will open when all clips finish rendering.
          </Text>
          <Text color="fg.subtle" fontSize="12px">You can leave this page and return to this import later.</Text>
        </>
      ) : (
        <Stack gap="3" align="flex-start" role="alert">
          <Text color="fg.muted" fontSize="14px">
            {detail.isError ? "Check your connection and try again. Your video is still saved."
              : progress?.errorCode ? userErrorMessage(progress.errorCode)
              : "Open the project to review the result and retry generation."}
          </Text>
          {detail.isError ? <Button size="sm" onClick={() => void detail.refetch()}>Try again</Button>
            : <Button size="sm" asChild><Link href={`/projects/${projectId}`}>Review and retry</Link></Button>}
        </Stack>
      )}
    </Stack>
  );
}
