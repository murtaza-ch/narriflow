"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useMemo } from "react";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { ArrowUpRight, Download, Film, Grid2X2, List, RefreshCw } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { describeApiFailure, type WorkspaceScope } from "@narriflow/api-client";
import {
  type ExportsClient,
  createExportsClient,
  exportCommands,
  exportMutationOptions,
  exportQueries,
  invalidateAfterExportChange,
} from "@narriflow/api-client/exports";
import {
  type WorkspaceExportItem,
  type WorkspaceExportsQuery,
  workspaceExportsQuerySchema,
} from "@narriflow/validators/api/exports";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { formatDateTime } from "@/lib/format";
import { useWorkspaceBootstrap } from "../_components/usage";
import { ExportFilters } from "./export-filters";
import { ExportPreview } from "./export-preview";
import ExportsLoading from "./loading";

type ClipExportStatus = WorkspaceExportItem["status"];
type DbAspectRatio = WorkspaceExportItem["variants"][number]["aspectRatio"];

const FILTERS: Array<{ label: string; value: "ready" | "processing" | "failed" | "all" }> = [
  { label: "All", value: "all" },
  { label: "Ready", value: "ready" },
  { label: "Processing", value: "processing" },
  { label: "Failed", value: "failed" },
];

type ExportSearchParams = Record<string, string | undefined>;

/** The filters the URL carries that the API accepts; anything malformed is dropped, as the page always did. */
function readFilters(params: URLSearchParams): WorkspaceExportsQuery {
  const filters: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(workspaceExportsQuerySchema.shape)) {
    const parsed = field.safeParse(params.get(key) ?? undefined);
    if (parsed.success && parsed.data) filters[key] = parsed.data;
  }
  return filters as WorkspaceExportsQuery;
}

function exportHref(
  params: ExportSearchParams,
  key: "status" | "view",
  value: string,
) {
  const next = new URLSearchParams();
  for (const [paramKey, paramValue] of Object.entries(params)) {
    if (paramValue) next.set(paramKey, paramValue);
  }
  if (value === "all" && key === "status") next.delete(key);
  else next.set(key, value);
  if (key === "status") next.delete("cursor");
  const query = next.toString();
  return query ? `/exports?${query}` : "/exports";
}

function ratioLabel(value: DbAspectRatio) {
  return value.replace("ratio_", "").replaceAll("_", ":");
}

const RATIO_VALUE: Record<DbAspectRatio, number> = { ratio_9_16: 9 / 16, ratio_1_1: 1, ratio_16_9: 16 / 9, ratio_4_5: 4 / 5 };

function fileSize(bytes: number | null) {
  if (bytes === null) return null;
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}

const STATUS_LABEL: Record<ClipExportStatus, string> = {
  queued: "Queued",
  rendering: "Rendering",
  partial_ready: "Partly ready",
  ready: "Ready",
  failed: "Failed",
};

function StatusPill({ status, progress, onFootage = false }: { status: ClipExportStatus; progress: number; onFootage?: boolean }) {
  const inProgress = status === "queued" || status === "rendering";
  const dot = status === "failed" ? "danger.solid" : status === "ready" ? "accent.solid" : inProgress ? "accent.solid" : "warning.solid";
  return (
    <Flex
      display="inline-flex"
      align="center"
      gap="1.5"
      h="6"
      px="2"
      borderRadius="full"
      bg={onFootage ? "studio.scrim" : "bg.soft"}
      color={onFootage ? "studio.fg" : status === "failed" ? "danger.fg" : "fg"}
      backdropFilter={onFootage ? "blur(6px)" : undefined}
      fontSize="11.5px"
      fontWeight="500"
      lineHeight="1"
      flexShrink={0}
    >
      {inProgress ? <Spinner size="xs" borderColor="accent.muted" borderTopColor="accent.solid" /> : <Box boxSize="1.5" borderRadius="full" bg={dot} />}
      <Text as="span" fontVariantNumeric="tabular-nums">
        {STATUS_LABEL[status]}
        {status === "rendering" ? ` ${progress}%` : ""}
      </Text>
    </Flex>
  );
}


/** The Exports list for the selected Workspace: scoped reads, no server data. */
export function ExportsScreen() {
  const scope = useWorkspaceScope();
  if (!scope) return <ExportsLoading />;
  return <ExportsContent key={scope.workspaceId} scope={scope} />;
}

function failureText(error: unknown) {
  return describeApiFailure(error).kind === "offline"
    ? "You appear to be offline. Check your connection and try again."
    : "Exports could not be loaded.";
}

/** Fetches a short-lived Download Grant on click and navigates to the file; no credentials ride along. */
function DownloadButton({
  client,
  exportId,
  variantId,
  size,
  ariaLabel,
  children,
}: {
  client: ExportsClient;
  exportId: string;
  variantId: string;
  size: "xs" | "sm";
  ariaLabel: string;
  children: ReactNode;
}) {
  const download = useMutation({
    ...exportMutationOptions,
    mutationFn: () => exportCommands.workspaceDownloadGrant(client, exportId, variantId),
    onSuccess: (grant) => window.location.assign(grant.downloadUrl),
  });
  return (
    <>
      <Button size={size} variant="subtle" aria-label={ariaLabel} loading={download.isPending} onClick={() => download.mutate()}>
        {children}
      </Button>
      {download.isError ? (
        <Text role="alert" fontSize="12px" color="danger.fg">
          {describeApiFailure(download.error).error.message || "The download could not be started."}
        </Text>
      ) : null}
    </>
  );
}

function RetryButton({ client, scope, item }: { client: ExportsClient; scope: WorkspaceScope; item: WorkspaceExportItem }) {
  const queryClient = useQueryClient();
  const retry = useMutation({
    ...exportMutationOptions,
    mutationFn: () => exportCommands.retryWorkspaceExport(client, item.id),
    onSuccess: () => invalidateAfterExportChange(queryClient, scope, item.projectId),
  });
  return (
    <>
      <Button size="sm" variant="ghost" loading={retry.isPending} loadingText="Retrying…" onClick={() => retry.mutate()}>
        <RefreshCw size={12} />Retry
      </Button>
      {retry.isError ? (
        <Text role="alert" fontSize="12px" color="danger.fg">
          {describeApiFailure(retry.error).error.message || "The action could not be completed."}
        </Text>
      ) : null}
    </>
  );
}

function ExportsContent({ scope }: { scope: WorkspaceScope }) {
  const runtime = useApiRuntime();
  const searchParams = useSearchParams();
  const client = useMemo(() => createExportsClient(runtime.transport.scoped(scope)), [runtime.transport, scope]);
  const filters = useMemo(() => readFilters(new URLSearchParams(searchParams.toString())), [searchParams]);
  const urlParams: ExportSearchParams = Object.fromEntries(searchParams.entries());
  // The grid shows each export's footage; the list is the compact alternative.
  const view = urlParams.view === "list" ? "list" : "grid";

  // Independent reads start together; the bootstrap only decides whether Retry shows.
  const list = useQuery({ ...exportQueries.workspaceList(client, scope, filters), placeholderData: keepPreviousData });
  const projectsQuery = useQuery(exportQueries.workspaceProjects(client, scope));
  const bootstrap = useWorkspaceBootstrap(scope);

  if (list.isError || projectsQuery.isError) {
    return (
      <Stack gap="4" role="alert" align="flex-start">
        <PageHeader title="Exports" description="Every rendered clip, ready to download." />
        <Text fontSize="13px" color="fg.muted">{failureText(list.error ?? projectsQuery.error)}</Text>
        <Button size="sm" variant="subtle" onClick={() => { void list.refetch(); void projectsQuery.refetch(); }}>Try again</Button>
      </Stack>
    );
  }
  if (!list.data || !projectsQuery.data) return <ExportsLoading />;

  const exportPage = list.data;
  const projects = projectsQuery.data.projects;
  const exports = exportPage.items;
  const canRetry = bootstrap.data?.capabilities["processing.consume"] === true;
  const hasFilters = Boolean(filters.status || filters.q || filters.project || filters.ratio || filters.from || filters.to);

  const downloadsOf = (item: WorkspaceExportItem) => item.variants.filter((variant) => variant.hasAsset);
  const previewOf = (item: WorkspaceExportItem) => {
    const ready = downloadsOf(item)[0];
    return {
      src: ready?.previewUrl ?? null,
      ratio: RATIO_VALUE[(ready ?? item.variants[0])?.aspectRatio ?? "ratio_9_16"],
    };
  };
  const detailsHref = (item: WorkspaceExportItem) => `/projects/${item.projectId}/clips/${item.clipId}/exports/${item.id}`;
  const retry = (item: WorkspaceExportItem) =>
    canRetry && (item.status === "failed" || item.status === "partial_ready") ? (
      <RetryButton client={client} scope={scope} item={item} />
    ) : null;

  return (
    <Stack gap="6">
      <Box animation="fade-up" animationFillMode="backwards" mb="2">
        <PageHeader title="Exports" description="Every rendered clip, ready to download." />
      </Box>
      <ExportFilters projects={projects} />
      <Flex gap="3" wrap="wrap" align="center" justify="space-between">
        <Flex as="nav" aria-label="Export status" gap="0.5" align="center" bg="bg.soft" borderRadius="control" p="0.5">
          {FILTERS.map((filter) => {
            const current = (filters.status ?? "all") === filter.value;
            return (
              <Button
                key={filter.value}
                size="sm"
                variant="ghost"
                h="8"
                asChild
                bg={current ? { _light: "white", _dark: "whiteAlpha.200" } : "transparent"}
                color={current ? "fg" : "fg.muted"}
                _hover={{ bg: current ? { _light: "white", _dark: "whiteAlpha.200" } : "bg.softHover", color: "fg" }}
              >
                <Link href={exportHref(urlParams, "status", filter.value)} aria-current={current ? "page" : undefined}>{filter.label}</Link>
              </Button>
            );
          })}
        </Flex>
        <Flex as="nav" aria-label="Layout" gap="0.5" align="center" bg="bg.soft" borderRadius="control" p="0.5">
          {(["grid", "list"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant="ghost"
              h="8"
              asChild
              bg={view === option ? { _light: "white", _dark: "whiteAlpha.200" } : "transparent"}
              color={view === option ? "fg" : "fg.muted"}
              _hover={{ bg: view === option ? { _light: "white", _dark: "whiteAlpha.200" } : "bg.softHover", color: "fg" }}
            >
              <Link href={exportHref(urlParams, "view", option)} aria-label={option === "grid" ? "Grid view" : "List view"} aria-current={view === option ? "page" : undefined}>
                {option === "grid" ? <Grid2X2 size={13} /> : <List size={13} />}
                {option === "grid" ? "Grid" : "List"}
              </Link>
            </Button>
          ))}
        </Flex>
      </Flex>
      {exports.length === 0 ? (
        <EmptyState icon={<Film size={22} />} title={hasFilters ? "No matching exports" : "No exports yet"} description={hasFilters ? "Try a different search, date range, or status." : "Export a clip from a project to see it here."} action={<Button asChild><Link href={hasFilters ? `/exports?view=${view}` : "/projects"}>{hasFilters ? "Clear filters" : "Browse projects"}</Link></Button>} />
      ) : view === "list" ? (
        <Stack gap="2">
          {exports.map((item) => {
            const preview = previewOf(item);
            return (
              <Flex key={item.id} align={{ base: "flex-start", md: "center" }} direction={{ base: "column", md: "row" }} gap="4" p="3" pe="4" borderRadius="l3" bg="bg.subtle">
                <Flex align="center" gap="4" flex="1" minW="0" w={{ base: "full", md: "auto" }}>
                  <Box w="48px" flexShrink={0} aspectRatio={9 / 16} borderRadius="8px" overflow="hidden">
                    <ExportPreview compact src={preview.src} ratio={preview.ratio} status={item.status} progress={item.progress} />
                  </Box>
                  <Stack gap="1" minW="0">
                    <Link href={detailsHref(item)}>
                      <Text fontSize="14px" fontWeight="500" truncate _hover={{ textDecoration: "underline", textUnderlineOffset: "3px" }}>{item.clip.title?.trim() || item.clip.hookText}</Text>
                    </Link>
                    <Text fontSize="12px" color="fg.subtle" truncate>{item.project.title} · {formatDateTime(item.createdAt)}</Text>
                  </Stack>
                </Flex>
                <Flex align="center" gap="2" wrap="wrap">
                  <StatusPill status={item.status} progress={item.progress} />
                  {downloadsOf(item).map((variant) => (
                    <DownloadButton key={variant.id} client={client} exportId={item.id} variantId={variant.id} size="sm" ariaLabel={`Download ${ratioLabel(variant.aspectRatio)}`}>
                      <Download size={13} />
                      {ratioLabel(variant.aspectRatio)}
                      {fileSize(variant.sizeBytes) ? <Text as="span" color="fg.subtle" fontWeight="400">{fileSize(variant.sizeBytes)}</Text> : null}
                    </DownloadButton>
                  ))}
                  {retry(item)}
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={detailsHref(item)}>Open <ArrowUpRight size={13} /></Link>
                  </Button>
                </Flex>
              </Flex>
            );
          })}
        </Stack>
      ) : (
        <Grid templateColumns={{ base: "repeat(2, minmax(0, 1fr))", md: "repeat(3, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))", xl: "repeat(5, minmax(0, 1fr))" }} gap="4" rowGap="6">
          {exports.map((item) => {
            const preview = previewOf(item);
            const downloads = downloadsOf(item);
            return (
              <Stack key={item.id} gap="3" minW="0" className="group">
                <Box position="relative" aspectRatio={9 / 16} borderRadius="l2" overflow="hidden">
                  <Link href={detailsHref(item)} aria-label={`Open ${item.clip.title?.trim() || item.clip.hookText}`}>
                    <ExportPreview src={preview.src} ratio={preview.ratio} status={item.status} progress={item.progress} />
                  </Link>
                  <Flex position="absolute" top="2" left="2" right="2" justify="space-between" gap="1" pointerEvents="none">
                    {item.status === "ready" ? <span /> : <StatusPill status={item.status} progress={item.progress} onFootage />}
                    <Flex gap="1">
                      {item.variants.map((variant) => (
                        <Flex key={variant.id} h="6" px="1.5" align="center" borderRadius="full" bg="studio.scrim" color="studio.fg" fontSize="11px" fontWeight="500" fontVariantNumeric="tabular-nums" backdropFilter="blur(6px)">
                          {ratioLabel(variant.aspectRatio)}
                        </Flex>
                      ))}
                    </Flex>
                  </Flex>
                </Box>
                <Stack gap="1" minW="0">
                  <Link href={detailsHref(item)}>
                    <Text fontSize="13.5px" fontWeight="500" lineClamp={2} _hover={{ textDecoration: "underline", textUnderlineOffset: "3px" }}>{item.clip.title?.trim() || item.clip.hookText}</Text>
                  </Link>
                  <Text fontSize="12px" color="fg.subtle" truncate>{item.project.title}</Text>
                  <Text fontSize="11.5px" color="fg.subtle" fontVariantNumeric="tabular-nums">{formatDateTime(item.createdAt)}</Text>
                </Stack>
                <Flex gap="1.5" wrap="wrap">
                  {downloads.map((variant) => (
                    <DownloadButton key={variant.id} client={client} exportId={item.id} variantId={variant.id} size="xs" ariaLabel={`Download ${ratioLabel(variant.aspectRatio)}`}>
                      <Download size={12} />
                      {downloads.length > 1 ? ratioLabel(variant.aspectRatio) : "Download"}
                      {fileSize(variant.sizeBytes) ? <Text as="span" color="fg.subtle" fontWeight="400">{fileSize(variant.sizeBytes)}</Text> : null}
                    </DownloadButton>
                  ))}
                  {retry(item)}
                </Flex>
              </Stack>
            );
          })}
        </Grid>
      )}
			{(filters.cursor || exportPage.nextCursor) && (
				<Flex gap="2" justify="end">
					{filters.cursor && <Button size="sm" variant="subtle" asChild><Link href={exportHref({ ...urlParams, cursor: undefined }, "view", view)}>Newest exports</Link></Button>}
					{exportPage.nextCursor && <Button size="sm" variant="subtle" asChild><Link href={exportHref({ ...urlParams, cursor: exportPage.nextCursor }, "view", view)}>Next</Link></Button>}
				</Flex>
			)}
    </Stack>
  );
}
