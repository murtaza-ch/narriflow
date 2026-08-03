"use client";

import { Box, Center, HStack, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { startTransition, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox, TriangleAlert } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import type { ProjectListItem, ProjectListPage } from "@narriflow/services";
import { FilterToolbar } from "./filter-toolbar";
import { ProjectCard } from "./project-card";
import { ProjectRow } from "./project-row";

export type StatusFilter =
  | "all"
  | "ready"
  | "processing"
  | "queued"
  | "failed";

export type SourceFilter = "all" | "youtube" | "link" | "upload" | "rss";

export type SortOption = "newest" | "oldest" | "title" | "clips";

export type ViewMode = "grid" | "list";

interface ProjectsExplorerProps {
  initialProjects: ProjectListItem[];
  initialNextCursor: string | null;
  totalCount: number;
}

const PROCESSING_STATUSES = new Set([
  "processing",
  "uploading",
  "downloading",
  "normalizing",
  "pending",
]);

const ACTIVE_INGEST_STATUSES = new Set([
  "pending",
  "uploading",
  "queued",
  "downloading",
  "normalizing",
]);

function isProjectActive(project: ProjectListItem): boolean {
  if (ACTIVE_INGEST_STATUSES.has(project.ingestStatus)) return true;
  const transcriptStatus = project.transcript?.status;
  return transcriptStatus === "queued" || transcriptStatus === "processing";
}

function matchesStatus(
  project: ProjectListItem,
  status: StatusFilter,
): boolean {
  if (status === "all") return true;
  const ingest = project.ingestStatus;
  if (status === "processing") return PROCESSING_STATUSES.has(ingest);
  return ingest === status;
}

/** How often the list re-asks the server while something is still processing. */
const LIVE_REFRESH_INTERVAL_MS = 6000;

/** A page fetched by "Load more" — kept alongside its own cursor/total so the
 *  derived values below need no effect to stay in sync. */
interface LoadedPage {
  items: ProjectListItem[];
  nextCursor: string | null;
  totalCount: number;
}

export function ProjectsExplorer({
  initialProjects,
  initialNextCursor,
  totalCount: initialTotalCount,
}: ProjectsExplorerProps) {
  const router = useRouter();
  // Page 1 always comes from the server props; only the extra pages that
  // "Load more" fetched live in state. Deriving the merged list (instead of
  // mirroring `initialProjects` into state via an effect) is what keeps a
  // `router.refresh()` to a single render pass — the old effect re-ran on
  // every refresh because the RSC payload hands over fresh array identities,
  // so each poll cost a setState + a second render of the whole grid, and
  // silently threw away every page the user had loaded.
  const [extraPages, setExtraPages] = useState<LoadedPage[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [sort, setSort] = useState<SortOption>("newest");
  const [view, setView] = useState<ViewMode>("grid");
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // A delete anywhere in the library decrements the server's total, and page 1
  // alone can't tell us which cached row below it disappeared — so drop the
  // cached pages and let the user re-load them. This is React's sanctioned
  // "adjust state when a prop changes" shape (a render-phase setState, which
  // re-runs this component only, and only on the rare shrink) rather than an
  // effect that would fire on every poll.
  const [lastServerTotal, setLastServerTotal] = useState(initialTotalCount);
  if (initialTotalCount !== lastServerTotal) {
    setLastServerTotal(initialTotalCount);
    if (initialTotalCount < lastServerTotal && extraPages.length > 0) {
      setExtraPages([]);
    }
  }

  // Refreshed page 1 wins on id collisions (a project created since the last
  // "Load more" can push older rows across the page boundary).
  const projects = useMemo(() => {
    if (extraPages.length === 0) return initialProjects;
    const merged = [...initialProjects];
    const seen = new Set(merged.map((project) => project.id));
    for (const page of extraPages) {
      for (const project of page.items) {
        if (seen.has(project.id)) continue;
        seen.add(project.id);
        merged.push(project);
      }
    }
    return merged;
  }, [initialProjects, extraPages]);

  const lastPage = extraPages.at(-1);
  const nextCursor = lastPage ? lastPage.nextCursor : initialNextCursor;
  const totalCount = lastPage
    ? Math.max(lastPage.totalCount, initialTotalCount)
    : initialTotalCount;

  // Live-refresh while any project is still ingesting/transcribing so cards
  // flip to "ready" (and clips appear) without a manual reload.
  const hasActiveProjects = useMemo(
    () => projects.some(isProjectActive),
    [projects],
  );

  useEffect(() => {
    if (!hasActiveProjects) return;

    // `router.refresh()` inside a transition: React keeps the current grid on
    // screen while the new RSC payload streams in, instead of tearing down to
    // the page's Suspense skeleton and remounting every card — the visible
    // "renders over and over" symptom.
    const refresh = () => startTransition(() => router.refresh());

    // A background tab has nothing to repaint, and each refresh re-runs the
    // layout (auth + usage stats) plus the paginated project query. Poll only
    // while visible, and catch up once on the way back.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, LIVE_REFRESH_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasActiveProjects, router]);

  // NOTE: filtering/search/sort run client-side over the LOADED pages only
  // (the server paginates at 50). For users with >50 projects, matches beyond
  // the loaded pages are invisible — moving filters to URL searchParams with
  // server-side filtering is backlogged. All counters below therefore use the
  // loaded count as their denominator and say so.
  const baseFiltered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();

    return projects.filter((project) => {
      if (source !== "all" && project.sourceType !== source) {
        return false;
      }

      if (trimmed) {
        const haystack = [
          project.title,
          project.sourceMediaUrl,
          project.sourceInput ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(trimmed)) return false;
      }

      return true;
    });
  }, [projects, query, source]);

  // Live counts for the status chips — computed on the source/search subset
  // so each chip's number is exactly what clicking it would show.
  const statusCounts = useMemo<Record<StatusFilter, number>>(
    () => ({
      all: baseFiltered.length,
      ready: baseFiltered.filter((p) => matchesStatus(p, "ready")).length,
      processing: baseFiltered.filter((p) => matchesStatus(p, "processing"))
        .length,
      queued: baseFiltered.filter((p) => matchesStatus(p, "queued")).length,
      failed: baseFiltered.filter((p) => matchesStatus(p, "failed")).length,
    }),
    [baseFiltered],
  );

  const filtered = useMemo(() => {
    const list = baseFiltered.filter((project) =>
      matchesStatus(project, status),
    );

    return [...list].sort((a, b) => {
      if (sort === "newest") {
        return b.createdAt.localeCompare(a.createdAt);
      }
      if (sort === "oldest") {
        return a.createdAt.localeCompare(b.createdAt);
      }
      if (sort === "title") {
        return a.title.localeCompare(b.title, undefined, {
          sensitivity: "base",
        });
      }
      if (sort === "clips") {
        return b.clipCount - a.clipCount;
      }
      return 0;
    });
  }, [baseFiltered, status, sort]);

  const hasActiveFilters =
    query.trim() !== "" || status !== "all" || source !== "all";

  function clearFilters() {
    setQuery("");
    setStatus("all");
    setSource("all");
  }

  async function loadMoreProjects() {
    if (!nextCursor || isLoadingMore) return;

    setIsLoadingMore(true);
    setLoadError(null);

    try {
      const params = new URLSearchParams({
        cursor: nextCursor,
        limit: "50",
      });
      const response = await fetch(`/api/projects?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to load more projects");
      const page = (await response.json()) as ProjectListPage;

      setExtraPages((current) => [
        ...current,
        {
          items: page.items,
          nextCursor: page.nextCursor,
          totalCount: page.totalCount,
        },
      ]);
    } catch {
      setLoadError("Could not load more projects. Try again.");
    } finally {
      setIsLoadingMore(false);
    }
  }

  return (
    <Stack gap="5">
      <FilterToolbar
        query={query}
        onQueryChange={setQuery}
        status={status}
        onStatusChange={setStatus}
        source={source}
        onSourceChange={setSource}
        sort={sort}
        onSortChange={setSort}
        view={view}
        onViewChange={setView}
        statusCounts={statusCounts}
        resultCount={filtered.length}
        loadedCount={projects.length}
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Inbox size={22} strokeWidth={1.5} />}
          title="No projects match your filters"
          description="Try a broader search or remove a filter to see more results."
          action={
            hasActiveFilters ? (
              <Button size="sm" variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : view === "grid" ? (
        <SimpleGrid columns={{ base: 1, sm: 2, lg: 3, "2xl": 4 }} gap="5">
          {filtered.map((project, index) => (
            <Box
              key={project.id}
              animation="fade-up"
              animationFillMode="backwards"
              style={{ animationDelay: `${Math.min(index, 11) * 60}ms` }}
            >
              <ProjectCard project={project} />
            </Box>
          ))}
        </SimpleGrid>
      ) : (
        <Box borderTopWidth="1px" borderTopColor="border.subtle">
          {filtered.map((project, index) => (
            <Box
              key={project.id}
              animation="fade-up"
              animationFillMode="backwards"
              style={{ animationDelay: `${Math.min(index, 11) * 40}ms` }}
            >
              <ProjectRow project={project} />
            </Box>
          ))}
        </Box>
      )}

      {nextCursor ? (
        <Center>
          <Stack align="center" gap="2">
            <Button
              size="sm"
              variant="outline"
              onClick={loadMoreProjects}
              loading={isLoadingMore}
            >
              Load more projects
            </Button>
            <Text textStyle="data" fontSize="11px" color="fg.subtle">
              Loaded {projects.length} of {totalCount}
            </Text>
            {loadError ? (
              <HStack gap="1.5" color="danger.fg">
                <TriangleAlert size={13} aria-hidden="true" />
                <Text fontSize="13px">{loadError}</Text>
              </HStack>
            ) : null}
          </Stack>
        </Center>
      ) : totalCount > projects.length ? (
        <Text
          textStyle="data"
          fontSize="11px"
          color="fg.subtle"
          textAlign="center"
        >
          Loaded {projects.length} of {totalCount}
        </Text>
      ) : null}
    </Stack>
  );
}
