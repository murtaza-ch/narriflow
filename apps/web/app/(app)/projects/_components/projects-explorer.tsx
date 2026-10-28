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
import { startTransition, useEffect, useEffectEvent, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Folder, FolderInput, Inbox, Search, TriangleAlert } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import {
  invalidateAfterProjectMoved,
  projectCommands,
  projectMutationOptions,
  projectQueries,
  type ProjectListFilters,
} from "@narriflow/api-client/projects";
import type {
  ProjectListSortValue,
  ProjectListSourceFilterValue,
  ProjectListStatusFilterValue,
} from "@narriflow/validators/api/projects";
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FilterToolbar } from "./filter-toolbar";
import { PROJECT_DRAG_TYPE } from "./folders-panel";
import { ProjectCard } from "./project-card";
import { ProjectRow } from "./project-row";
import { ProjectsGridSkeleton } from "./projects-skeleton";
import { failureMessage, type LibraryApi, type ProjectListItem } from "../_lib/api";

export type StatusFilter = ProjectListStatusFilterValue;
export type SourceFilter = ProjectListSourceFilterValue;
export type SortOption = ProjectListSortValue;

export type ViewMode = "grid" | "list";

interface ProjectsExplorerProps {
  api: LibraryApi;
  /** The filters in the URL. */
  filters: ProjectListFilters;
  /** False while the explorer is still loading page 1 for `filters`. */
  ready: boolean;
  folderName?: string;
  folders: Array<{ id: string; name: string }>;
  canEdit: boolean;
}

function MoveProjectsDialog({
  api,
  projects,
  folders,
  onMoved,
}: {
  api: LibraryApi;
  projects: ProjectListItem[];
  folders: Array<{ id: string; name: string }>;
  onMoved: () => void;
}) {
  const queryClient = useQueryClient();
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

  const moveMutation = useMutation({
    ...projectMutationOptions,
    mutationFn: async (folderId: string | null) => {
      const results = await Promise.allSettled(
        projects.map((project) => projectCommands.moveToFolder(api.projects, project.id, folderId)),
      );
      // Some moves may have landed even when another failed, so the lists refresh either way.
      await Promise.all(projects.map((project) => invalidateAfterProjectMoved(queryClient, api.scope, project.id)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    },
    onSuccess: () => {
      setMoveError(null);
      setOpen(false);
      onMoved();
    },
    onError: (error) => setMoveError(failureMessage(error, "The projects could not be moved.")),
  });
  const pending = moveMutation.isPending;

  function move() {
    moveMutation.mutate(selectedFolderId || null);
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
        <Button size="sm" variant="subtle" disabled={projects.length === 0}>
          <FolderInput size={16} />
          Move to
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="480px">
            <Dialog.Header>
              <Dialog.Title fontSize="18px" fontWeight="500">
                {title}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <InputGroup color="fg.subtle" startElement={<Search size={16} />}>
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
                        variant="ghost"
                        justifyContent="flex-start"
                        bg={selected ? "accent.subtle" : undefined}
                        color={selected ? "accent.fg" : undefined}
                        _hover={{ bg: selected ? "accent.subtle" : "bg.soft" }}
                        onClick={() => setSelectedFolderId(destination.id)}
                      >
                        <Folder size={16} />
                        <Text flex="1" textAlign="left">
                          {destination.name}
                        </Text>
                        {selected ? (
                          <Text fontSize="12px">
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
                <Dialog.ActionTrigger asChild>
                  <Button size="sm" variant="subtle">
                    Cancel
                  </Button>
                </Dialog.ActionTrigger>
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

export function isProjectActive(project: Pick<ProjectListItem, "progress">): boolean {
  return project.progress.active;
}

/** How often the list re-asks the server while something is still processing. */
const LIVE_REFRESH_INTERVAL_MS = 6000;

export function ProjectsExplorer({
  api,
  filters,
  ready,
  folderName,
  folders,
  canEdit,
}: ProjectsExplorerProps) {
  const router = useRouter();
  const initialQuery = filters.q ?? "";
  const initialStatus = filters.status ?? "all";
  const initialSource = filters.source ?? "all";
  const initialSort = filters.sort ?? "newest";
  const folderId = filters.folder;
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [source, setSource] = useState<SourceFilter>(initialSource);
  const [sort, setSort] = useState<SortOption>(initialSort);
  const [view, setView] = useState<ViewMode>("grid");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const filterKey = `${initialQuery}\u0000${initialStatus}\u0000${initialSource}\u0000${initialSort}\u0000${folderId ?? ""}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setQuery(initialQuery);
    setStatus(initialStatus);
    setSource(initialSource);
    setSort(initialSort);
    setSelectedIds([]);
  }

  // Every loaded page of these filters. Page 1 comes from the explorer read; a
  // refetch (polling, focus) re-reads each loaded page in order, so extra pages
  // keep their place instead of being thrown away. The list query's progress
  // meaning is shared across intake and Workflow Runs, so polling continues
  // through transcription, detection and rendering until every visible Project
  // reaches a terminal outcome. It runs only while the tab is visible, and
  // focus refetches once on the way back.
  const list = useInfiniteQuery({
    ...projectQueries.list(api.projects, api.scope, filters),
    enabled: ready,
    placeholderData: keepPreviousData,
    refetchInterval: (current) =>
      current.state.data?.pages.some((page) => page.items.some(isProjectActive)) ? LIVE_REFRESH_INTERVAL_MS : false,
  });
  const pages = list.data?.pages;

  // Earlier pages win on id collisions (a project created since the last
  // "Load more" can push older rows across a page boundary).
  const projects = useMemo(() => {
    const merged: ProjectListItem[] = [];
    const seen = new Set<string>();
    for (const page of pages ?? []) {
      for (const project of page.items) {
        if (seen.has(project.id)) continue;
        seen.add(project.id);
        merged.push(project);
      }
    }
    return merged;
  }, [pages]);
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

  const nextCursor = pages?.at(-1)?.nextCursor ?? null;
  const totalCount = Math.max(pages?.[0]?.totalCount ?? 0, pages?.at(-1)?.totalCount ?? 0);
  const isLoadingMore = list.isFetchingNextPage;
  const loadError = list.isFetchNextPageError ? "Could not load more projects. Try again." : null;

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

  function loadMoreProjects() {
    if (nextCursor && !list.isFetchingNextPage) void list.fetchNextPage();
  }

  if (!pages) return <ProjectsGridSkeleton />;

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
              api={api}
              projects={selectedProjects}
              folders={folders}
              onMoved={() => setSelectedIds([])}
            />
          ) : undefined
        }
      />

      {projects.length === 0 ? (
        <EmptyState
          icon={<Inbox size={20} strokeWidth={1.5} />}
          title={folderName && !hasActiveFilters ? "This folder is empty" : "No projects match your filters"}
          description={folderName && !hasActiveFilters ? (canEdit ? "Move a project here from All projects." : "Nothing is in this folder yet.") : "Try another search or clear filters."}
          action={
            hasActiveFilters ? (
              <Button size="sm" variant="subtle" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : folderName ? (
              <Button size="sm" variant="subtle" asChild>
                <Link href="/projects">All projects</Link>
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
              onDragStart={(event) => event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id)}
              animation="fade-up"
              animationFillMode="backwards"
              style={{ animationDelay: `${Math.min(index, 11) * 60}ms` }}
            >
              <ProjectCard
                project={project}
                priority={index < 4}
                selectable={canEdit}
                canDelete={canEdit}
                selected={selectedIds.includes(project.id)}
                onSelectedChange={(selected) => setProjectSelected(project.id, selected)}
              />
            </Box>
          ))}
        </Grid>
      ) : (
        <Stack gap="2">
          {projects.map((project, index) => (
            <Box
              key={project.id}
              draggable={canEdit}
              onDragStart={(event) => event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id)}
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
              variant="subtle"
              onClick={loadMoreProjects}
              loading={isLoadingMore}
            >
              Load more projects
            </Button>
            <Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums">
              Loaded {projects.length} of {totalCount}
            </Text>
            {loadError ? (
              <HStack gap="1.5" color="danger.fg">
                <TriangleAlert size={16} aria-hidden="true" />
                <Text fontSize="13px">{loadError}</Text>
              </HStack>
            ) : null}
          </Stack>
        </Center>
      ) : totalCount > projects.length ? (
        <Text
          fontSize="12px"
          color="fg.subtle"
          fontVariantNumeric="tabular-nums"
          textAlign="center"
        >
          Loaded {projects.length} of {totalCount}
        </Text>
      ) : null}
    </Stack>
  );
}
