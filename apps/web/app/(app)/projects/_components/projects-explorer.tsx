"use client";

import {
  Box,
  Center,
  Dialog,
  Flex,
  Grid,
  HStack,
  Input,
  InputGroup,
  Portal,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Folder, FolderInput, Inbox, Search, TriangleAlert } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import type {
  ProjectListItem,
  ProjectListPage,
  ProjectListSort,
  ProjectListSourceFilter,
  ProjectListStatusFilter,
} from "@narriflow/services";
import { FilterToolbar } from "./filter-toolbar";
import { ProjectCard } from "./project-card";
import { ProjectRow } from "./project-row";
import { moveProjectToFolderAction } from "../actions";
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

export type StatusFilter = ProjectListStatusFilter;
export type SourceFilter = ProjectListSourceFilter;
export type SortOption = ProjectListSort;

export type ViewMode = "grid" | "list";

interface ProjectsExplorerProps {
  initialProjects: ProjectListItem[];
  initialNextCursor: string | null;
  totalCount: number;
  initialQuery: string;
  initialStatus: StatusFilter;
  initialSource: SourceFilter;
  initialSort: SortOption;
  folderId?: string;
  folderName?: string;
  folders: Array<{ id: string; name: string }>;
  canEdit: boolean;
}

function MoveProjectsDialog({
  projects,
  folders,
  onMoved,
}: {
  projects: ProjectListItem[];
  folders: Array<{ id: string; name: string }>;
  onMoved: () => void;
}) {
  const router = useRouter();
  const [pending, startMove] = useTransition();
  const [moveError, setMoveError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const currentFolderId =
    projects.length > 0 &&
    projects.every((project) => project.folderId === projects[0]?.folderId)
      ? (projects[0]?.folderId ?? "")
      : null;
  const [selectedFolderId, setSelectedFolderId] = useState(currentFolderId ?? "");

  useEffect(() => {
    setSelectedFolderId(currentFolderId ?? "");
  }, [currentFolderId]);

  const destinations = [
    { id: "", name: "Projects" },
    ...folders.map((folder) => ({ id: folder.id, name: folder.name })),
  ].filter((folder) => folder.name.toLowerCase().includes(query.trim().toLowerCase()));

  function move() {
    startMove(async () => {
      const results = await Promise.all(
        projects.map((project) =>
          moveProjectToFolderAction(project.id, selectedFolderId || null),
        ),
      );
      const failure = results.find(isAuthenticatedActionFailure);
      if (failure) {
        setMoveError(
          authenticatedActionResultMessage(failure, "The projects could not be moved."),
        );
        return;
      }
      setMoveError(null);
      setOpen(false);
      onMoved();
      router.refresh();
    });
  }

  const title =
    projects.length === 1
      ? `Move “${projects[0]?.title ?? "project"}”`
      : `Move ${projects.length} projects`;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        setOpen(details.open);
        if (details.open) {
          setQuery("");
          setMoveError(null);
          setSelectedFolderId(currentFolderId ?? "");
        }
      }}
      placement="center"
    >
      <Dialog.Trigger asChild>
        <Button size="sm" variant="outline" disabled={projects.length === 0}>
          <FolderInput size={13} />
          Move to
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="480px">
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <InputGroup color="fg.subtle" startElement={<Search size={13} />}>
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder="Search folders"
                    aria-label="Search folders"
                  />
                </InputGroup>
                <Stack gap="1">
                  {destinations.map((destination) => {
                    const selected = selectedFolderId === destination.id;
                    return (
                      <Button
                        key={destination.id || "projects"}
                        size="sm"
                        variant={selected ? "outline" : "ghost"}
                        justifyContent="flex-start"
                        onClick={() => setSelectedFolderId(destination.id)}
                      >
                        <Folder size={14} />
                        <Text flex="1" textAlign="left">
                          {destination.name}
                        </Text>
                        {selected ? (
                          <Text fontSize="11px" color="fg.subtle">
                            {currentFolderId === destination.id ? "Current" : "Selected"}
                          </Text>
                        ) : null}
                      </Button>
                    );
                  })}
                </Stack>
                {moveError ? (
                  <Text role="alert" fontSize="12px" color="danger.fg">
                    {moveError}
                  </Text>
                ) : null}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Flex justify="flex-end" gap="2" w="full">
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={move}
                  loading={pending}
                  disabled={
                    projects.length === 0 ||
                    (currentFolderId !== null && selectedFolderId === currentFolderId)
                  }
                >
                  Move
                </Button>
              </Flex>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

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
  initialQuery,
  initialStatus,
  initialSource,
  initialSort,
  folderId,
  folderName,
  folders,
  canEdit,
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
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [source, setSource] = useState<SourceFilter>(initialSource);
  const [sort, setSort] = useState<SortOption>(initialSort);
  const [view, setView] = useState<ViewMode>("grid");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const filterKey = `${initialQuery}\u0000${initialStatus}\u0000${initialSource}\u0000${initialSort}\u0000${folderId ?? ""}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setQuery(initialQuery);
    setStatus(initialStatus);
    setSource(initialSource);
    setSort(initialSort);
    setExtraPages([]);
    setSelectedIds([]);
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
  const selectedProjects = useMemo(
    () => projects.filter((project) => selectedIds.includes(project.id)),
    [projects, selectedIds],
  );

  function setProjectSelected(projectId: string, selected: boolean) {
    setSelectedIds((current) =>
      selected
        ? current.includes(projectId)
          ? current
          : [...current, projectId]
        : current.filter((id) => id !== projectId),
    );
  }

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

  function apiParams(cursor: string) {
    const params = new URLSearchParams({ cursor, limit: "50" });
    if (folderId) params.set("folder", folderId);
    if (initialQuery) params.set("q", initialQuery);
    if (initialStatus !== "all") params.set("status", initialStatus);
    if (initialSource !== "all") params.set("source", initialSource);
    if (initialSort !== "newest") params.set("sort", initialSort);
    return params;
  }

  const refresh = useEffectEvent(async () => {
    startTransition(() => router.refresh());

    if (extraPages.length === 0 || !initialNextCursor) return;
    const refreshed: LoadedPage[] = [];
    let cursor: string | null = initialNextCursor;
    for (let index = 0; index < extraPages.length && cursor; index += 1) {
      const response = await fetch(`/api/projects?${apiParams(cursor)}`);
      if (!response.ok) return;
      const page = (await response.json()) as ProjectListPage;
      refreshed.push(page);
      cursor = page.nextCursor;
    }
    setExtraPages(refreshed);
  });

  useEffect(() => {
    if (!hasActiveProjects) return;

    // A background tab has nothing to repaint, and each refresh re-runs the
    // layout (auth + usage stats) plus the paginated project query. Poll only
    // while visible, and catch up once on the way back.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, LIVE_REFRESH_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasActiveProjects]);

  function navigate(next: {
    query?: string;
    status?: StatusFilter;
    source?: SourceFilter;
    sort?: SortOption;
  }) {
    const nextQuery = next.query ?? query;
    const nextStatus = next.status ?? status;
    const nextSource = next.source ?? source;
    const nextSort = next.sort ?? sort;
    const params = new URLSearchParams();
    if (folderId) params.set("folder", folderId);
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    if (nextStatus !== "all") params.set("status", nextStatus);
    if (nextSource !== "all") params.set("source", nextSource);
    if (nextSort !== "newest") params.set("sort", nextSort);
    const suffix = params.toString();
    startTransition(() => router.replace(suffix ? `/projects?${suffix}` : "/projects"));
  }

  const navigateToQuery = useEffectEvent((nextQuery: string) => {
    navigate({ query: nextQuery });
  });

  useEffect(() => {
    if (query.trim() === initialQuery) return;
    const timer = setTimeout(() => navigateToQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query, initialQuery]);

  const hasActiveFilters =
    query.trim() !== "" || status !== "all" || source !== "all";

  function clearFilters() {
    setQuery("");
    setStatus("all");
    setSource("all");
    navigate({ query: "", status: "all", source: "all" });
  }

  async function loadMoreProjects() {
    if (!nextCursor || isLoadingMore) return;

    setIsLoadingMore(true);
    setLoadError(null);

    try {
      const params = apiParams(nextCursor);
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
        onStatusChange={(value) => {
          setStatus(value);
          navigate({ status: value });
        }}
        source={source}
        onSourceChange={(value) => {
          setSource(value);
          navigate({ source: value });
        }}
        sort={sort}
        onSortChange={(value) => {
          setSort(value);
          navigate({ sort: value });
        }}
        view={view}
        onViewChange={setView}
        selectedCount={selectedProjects.length}
        onClearSelection={() => setSelectedIds([])}
        selectionAction={
          canEdit ? (
            <MoveProjectsDialog
              projects={selectedProjects}
              folders={folders}
              onMoved={() => setSelectedIds([])}
            />
          ) : undefined
        }
      />

      {projects.length === 0 ? (
        <EmptyState
          icon={<Inbox size={22} strokeWidth={1.5} />}
          title={folderName && !hasActiveFilters ? "This folder is empty" : "No projects match your filters"}
          description={folderName && !hasActiveFilters ? "Move a project here or start a new upload." : "Try another search or clear filters."}
          action={
            hasActiveFilters ? (
              <Button size="sm" variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : view === "grid" ? (
        <Grid
          gap="4"
          templateColumns="repeat(auto-fill, minmax(min(100%, 260px), 1fr))"
        >
          {projects.map((project, index) => (
            <Box
              key={project.id}
              draggable={canEdit}
              onDragStart={(event) => event.dataTransfer.setData("application/x-narriflow-project", project.id)}
              animation="fade-up"
              animationFillMode="backwards"
              style={{ animationDelay: `${Math.min(index, 11) * 60}ms` }}
            >
              <ProjectCard
                project={project}
                priority={index < 4}
                selectable={canEdit}
                selected={selectedIds.includes(project.id)}
                onSelectedChange={(selected) => setProjectSelected(project.id, selected)}
              />
            </Box>
          ))}
        </Grid>
      ) : (
        <Stack gap="4">
          {projects.map((project, index) => (
            <Box
              key={project.id}
              draggable={canEdit}
              onDragStart={(event) => event.dataTransfer.setData("application/x-narriflow-project", project.id)}
              animation="fade-up"
              animationFillMode="backwards"
              style={{ animationDelay: `${Math.min(index, 11) * 40}ms` }}
            >
              <ProjectRow
                project={project}
                selectable={canEdit}
                selected={selectedIds.includes(project.id)}
                onSelectedChange={(selected) => setProjectSelected(project.id, selected)}
              />
            </Box>
          ))}
        </Stack>
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
