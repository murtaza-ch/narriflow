"use client";

import { Box, Center, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { Inbox } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import type { ProjectListItem } from "@narriflow/services";
import { FilterToolbar } from "./filter-toolbar";
import { ProjectCard } from "./project-card";

export type StatusFilter =
  | "all"
  | "ready"
  | "processing"
  | "queued"
  | "failed";

export type SourceFilter = "all" | "youtube" | "upload" | "rss";

export type SortOption = "newest" | "oldest" | "title" | "clips";

interface ProjectsExplorerProps {
  initialProjects: ProjectListItem[];
}

const PROCESSING_STATUSES = new Set([
  "processing",
  "uploading",
  "downloading",
  "normalizing",
  "pending",
]);

export function ProjectsExplorer({ initialProjects }: ProjectsExplorerProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [sort, setSort] = useState<SortOption>("newest");

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();

    const filteredList = initialProjects.filter((project) => {
      if (source !== "all" && project.sourceType !== source) {
        return false;
      }

      if (status !== "all") {
        const ingest = project.ingestStatus;
        if (status === "processing") {
          if (!PROCESSING_STATUSES.has(ingest)) return false;
        } else if (status === "queued") {
          if (ingest !== "queued") return false;
        } else if (status === "ready") {
          if (ingest !== "ready") return false;
        } else if (status === "failed") {
          if (ingest !== "failed") return false;
        }
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

    return [...filteredList].sort((a, b) => {
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
  }, [initialProjects, query, status, source, sort]);

  const hasActiveFilters =
    query.trim() !== "" || status !== "all" || source !== "all";

  function clearFilters() {
    setQuery("");
    setStatus("all");
    setSource("all");
  }

  return (
    <Stack gap="20px">
      <FilterToolbar
        query={query}
        onQueryChange={setQuery}
        status={status}
        onStatusChange={setStatus}
        source={source}
        onSourceChange={setSource}
        sort={sort}
        onSortChange={setSort}
        resultCount={filtered.length}
        totalCount={initialProjects.length}
      />

      {filtered.length === 0 ? (
        <FilteredEmpty
          hasActiveFilters={hasActiveFilters}
          onClear={clearFilters}
        />
      ) : (
        <SimpleGrid
          columns={{ base: 1, sm: 2, lg: 3, "2xl": 4 }}
          gap="20px"
        >
          {filtered.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}

function FilteredEmpty({
  hasActiveFilters,
  onClear,
}: {
  hasActiveFilters: boolean;
  onClear: () => void;
}) {
  return (
    <Center
      py="64px"
      px="24px"
      borderRadius="14px"
      borderWidth="1px"
      borderColor="border"
      borderStyle="dashed"
      bg="bg.subtle"
    >
      <Stack align="center" gap="14px" textAlign="center" maxW="320px">
        <Box color="fg.subtle">
          <Inbox size={28} strokeWidth={1.5} />
        </Box>
        <Stack gap="4px" align="center">
          <Text fontSize="14px" fontWeight="600" color="fg">
            No projects match your filters
          </Text>
          <Text fontSize="13px" color="fg.muted" lineHeight="1.5">
            Try a broader search or remove a filter to see more results.
          </Text>
        </Stack>
        {hasActiveFilters ? (
          <Button size="sm" variant="outline" onClick={onClear}>
            Clear filters
          </Button>
        ) : null}
      </Stack>
    </Center>
  );
}
