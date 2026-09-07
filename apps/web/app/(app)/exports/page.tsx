import Link from "next/link";
import { Box, Flex, Grid, Input, Stack, Text } from "@chakra-ui/react";
import { Download, Film, Grid2X2, List, RefreshCw } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Button } from "@narriflow/ui/components/button";
import { ActionSubmitButton } from "@narriflow/ui/components/action-submit-button";
import { DatePicker } from "@narriflow/ui/components/date-picker";
import { Select } from "@narriflow/ui/components/select";
import { workspaceLibraryService } from "@narriflow/services";
import type { ClipAspectRatio, ClipExportStatus } from "@prisma/client";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { formatDateTime } from "@/lib/format";
import { retryWorkspaceExportAction } from "./actions";
import { AuthenticatedActionForm } from "@/app/_components/authenticated-action-form";

const FILTERS: Array<{ label: string; value: ClipExportStatus | "processing" | "all";
}> = [
  { label: "All", value: "all" },
  { label: "Ready", value: "ready" },
  { label: "Processing", value: "processing" },
  { label: "Failed", value: "failed" },
];

type ExportSearchParams = {
  status?: string;
  q?: string;
  project?: string;
  ratio?: string;
  from?: string;
  to?: string;
  view?: string;
};

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
  const query = next.toString();
  return query ? `/exports?${query}` : "/exports";
}

function ratioLabel(value: ClipAspectRatio) {
  return value.replace("ratio_", "").replaceAll("_", ":");
}

export default async function ExportsPage({
  searchParams,
}: {
    searchParams: Promise<ExportSearchParams>;
}) {
  const appUser = await admitWorkspacePage("content.view");
  const params = await searchParams;
  const status = FILTERS.some((filter) => filter.value === params.status)
    ? (params.status as ClipExportStatus | "processing")
    : undefined;
  const aspectRatios: ClipAspectRatio[] = ["ratio_9_16", "ratio_1_1", "ratio_16_9", "ratio_4_5",
  ];
  const aspectRatio = aspectRatios.includes(params.ratio as ClipAspectRatio) ? (params.ratio as ClipAspectRatio)
    : undefined;
  const from = params.from && !Number.isNaN(Date.parse(params.from)) ? new Date(`${params.from}T00:00:00.000Z`) : undefined;
  const to = params.to && !Number.isNaN(Date.parse(params.to)) ? new Date(`${params.to}T23:59:59.999Z`) : undefined;
  const view = params.view === "grid" ? "grid" : "list";
  const canRetry =
    appUser.workspace.status === "active" &&
    appUser.workspace.role !== "viewer";
  const [exports, projects] = await Promise.all([
    workspaceLibraryService.listExports(
      appUser.actorUserId,
      appUser.workspaceId,
      { status, query: params.q, projectId: params.project, aspectRatio, from, to,
      },
    ),
    workspaceLibraryService.listExportProjects(appUser.actorUserId, appUser.workspaceId,
    ),
  ]);

  const hasFilters = Boolean(status || params.q || params.project || params.ratio || params.from || params.to);

  return (
    <Stack gap="8">
      <PageHeader title="Exports" description="Finished clips and exports in progress, all in one place." />
      <form method="get" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end",
        }}>
        <Stack gap="1" flex={{ base: "1 1 100%", md: "1 1 220px" }}>
          <label htmlFor="export-search"><Text as="span" fontSize="13px" fontWeight="500" color="fg.muted">Search</Text></label>
          <Input id="export-search" name="q" defaultValue={params.q} placeholder="Project or clip" />
        </Stack>
        <Stack gap="1" flex={{ base: "1 1 180px", md: "0 1 220px" }} minW="0">
          <label htmlFor="export-project"><Text as="span" fontSize="13px" fontWeight="500" color="fg.muted">Project</Text></label>
          <Select id="export-project" name="project" ariaLabel="Export project" defaultValue={params.project ?? ""} w="full" items={[{ value: "", label: "All projects" }, ...projects.map((project) => ({ value: project.id, label: project.title,
              })),
            ]} />
        </Stack>
        <Stack gap="1" flex={{ base: "1 1 120px", md: "0 1 150px" }} minW="0">
          <label htmlFor="export-ratio"><Text as="span" fontSize="13px" fontWeight="500" color="fg.muted">Format</Text></label>
          <Select id="export-ratio" name="ratio" ariaLabel="Export format" defaultValue={params.ratio ?? ""} w="full" items={[{ value: "", label: "All formats" }, { value: "ratio_9_16", label: "9:16" }, { value: "ratio_1_1", label: "1:1" }, { value: "ratio_16_9", label: "16:9" }, { value: "ratio_4_5", label: "4:5" },
            ]} />
        </Stack>
        <Box flex={{ base: "1 1 140px", md: "0 1 180px" }}><DatePicker name="from" label="From date" defaultValue={params.from} width="100%" /></Box>
        <Box flex={{ base: "1 1 140px", md: "0 1 180px" }}><DatePicker name="to" label="To date" defaultValue={params.to} width="100%" /></Box>
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <input type="hidden" name="view" value={view} />
        <Button type="submit" size="sm" variant="outline">Apply</Button>
      </form>
      <Flex gap="2" wrap="wrap">
        {FILTERS.map((filter) => (
          <Button key={filter.value} size="sm" variant={(params.status ?? "all") === filter.value ? "outline" : "ghost"} asChild>
            <Link href={exportHref(params, "status", filter.value)}>{filter.label}</Link>
          </Button>
        ))}
        <Box flex="1" />
        <Button size="sm" variant={view === "list" ? "outline" : "ghost"} asChild>
          <Link href={exportHref(params, "view", "list")} aria-label="List view"><List size={13} />List</Link>
        </Button>
        <Button size="sm" variant={view === "grid" ? "outline" : "ghost"} asChild>
          <Link href={exportHref(params, "view", "grid")} aria-label="Grid view"><Grid2X2 size={13} />Grid</Link>
        </Button>
      </Flex>
      {exports.length === 0 ? (
        <EmptyState icon={<Film size={22} />} title={hasFilters ? "No matching exports" : "No exports yet"} description={hasFilters ? "Try a different search, date range, or status." : "Export a clip from a project to see it here."} action={<Button asChild><Link href={hasFilters ? `/exports?view=${view}` : "/projects"}>{hasFilters ? "Clear filters" : "Browse projects"}</Link></Button>} />
      ) : view === "list" ? (
        <Stack gap="3">
          {exports.map((item) => (
            <Flex key={item.id} align={{ base: "flex-start", md: "center" }} direction={{ base: "column", md: "row" }} gap="4" p="4" borderWidth="1px" borderColor="border" borderRadius="l2" bg="bg.panel">

              <Stack gap="0.5" flex="1" minW="0" w={{ base: "full", md: "auto" }}>
                <Text fontSize="13px" fontWeight="600" truncate>{item.clip.title?.trim() || item.clip.hookText}</Text>
                <Text fontSize="11px" color="fg.subtle" truncate>{item.project.title} · {formatDateTime(item.createdAt)}</Text>
              </Stack>
              <Flex align="center" gap="3" wrap="wrap">
                <Text fontSize="11px" px="2" py="1" borderRadius="full" bg={item.status === "ready" ? "success.subtle" : item.status === "failed" ? "danger.subtle" : "bg.muted"} color={item.status === "ready" ? "success.fg" : item.status === "failed" ? "danger.fg" : "fg.muted"}>{item.status.replaceAll("_", " ")}</Text>
                <Flex gap="1">
                  {item.variants.filter((variant) => variant.status === "completed" && variant.storageKey,
                    ).map((variant) => (
                    <Button key={variant.id} size="sm" variant="ghost" asChild>
                      <a href={`/api/workspace/exports/${item.id}/download?variant=${variant.id}`} aria-label={`Download ${ratioLabel(variant.aspectRatio)}`}><Download size={12} />{ratioLabel(variant.aspectRatio)}</a>
                    </Button>
                  ))}
                </Flex>
                {canRetry && (item.status === "failed" || item.status === "partial_ready") ? (
                  <AuthenticatedActionForm action={retryWorkspaceExportAction.bind(null, item.id)}>
                    <ActionSubmitButton pendingLabel="Retrying…" size="sm" variant="ghost"><RefreshCw size={12} />Retry</ActionSubmitButton>
                  </AuthenticatedActionForm>
                ) : null}
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/projects/${item.projectId}/clips/${item.clipId}/exports/${item.id}`}>Open</Link>
                </Button>
              </Flex>
            </Flex>
          ))}
        </Stack>
      ) : (
        <Grid templateColumns={{ base: "1fr", md: "repeat(2, minmax(0, 1fr))", xl: "repeat(3, minmax(0, 1fr))",
          }} gap="4">
          {exports.map((item) => (
            <Stack key={item.id} gap="4" borderWidth="1px" borderRadius="l3" borderColor="border" bg="bg.panel" p="5">
              <Stack gap="1" flex="1"><Text fontSize="14px" fontWeight="600" lineClamp={2}>{item.clip.title?.trim() || item.clip.hookText}</Text><Text fontSize="11px" color="fg.subtle">{item.project.title}</Text></Stack>
              <Flex align="center" justify="space-between" gap="3"><Text fontSize="11px" px="2" py="1" borderRadius="full" bg={item.status === "ready" ? "success.subtle" : item.status === "failed" ? "danger.subtle" : "bg.muted"} color={item.status === "ready" ? "success.fg" : item.status === "failed" ? "danger.fg" : "fg.muted"}>{item.status.replaceAll("_", " ")}</Text><Text textStyle="data" fontSize="11px" color="fg.subtle">{formatDateTime(item.createdAt)}</Text></Flex>
              <Flex gap="1" wrap="wrap">
                {item.variants.filter((variant) => variant.status === "completed" && variant.storageKey,
                  ).map((variant) => (
                  <Button key={variant.id} size="sm" variant="outline" asChild>
                    <a href={`/api/workspace/exports/${item.id}/download?variant=${variant.id}`}><Download size={12} />{ratioLabel(variant.aspectRatio)}</a>
                  </Button>
                ))}
                <Button size="sm" variant="ghost" asChild><Link href={`/projects/${item.projectId}/clips/${item.clipId}/exports/${item.id}`}>Open details</Link></Button>
              </Flex>
            </Stack>
          ))}
        </Grid>
      )}
    </Stack>
  );
}
