"use client";

import type { ReactNode } from "react";
import {
  Collapsible,
  Flex,
  Grid,
  Input,
  InputGroup,
  Stack,
  Text,
  VisuallyHidden,
} from "@chakra-ui/react";
import { Filter, LayoutGrid, Rows3, Search, X } from "lucide-react";
import { IconButton } from "@narriflow/ui/components/button";
import { Select } from "@narriflow/ui/components/select";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import type { SourceFilter, SortOption, StatusFilter, ViewMode } from "./projects-explorer";

interface FilterToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  status: StatusFilter;
  onStatusChange: (value: StatusFilter) => void;
  source: SourceFilter;
  onSourceChange: (value: SourceFilter) => void;
  sort: SortOption;
  onSortChange: (value: SortOption) => void;
  view: ViewMode;
  onViewChange: (value: ViewMode) => void;
  selectedCount: number;
  onClearSelection: () => void;
  selectionAction?: ReactNode;
}

const STATUS_ITEMS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "ready", label: "Ready" },
  { value: "processing", label: "Processing" },
  { value: "queued", label: "Queued" },
  { value: "failed", label: "Failed" },
];

const SOURCE_ITEMS: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All sources" },
  { value: "youtube", label: "YouTube" },
  { value: "link", label: "Link import" },
  { value: "upload", label: "Upload" },
  { value: "rss", label: "RSS" },
];

const SORT_ITEMS: { value: SortOption; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "title", label: "Title A→Z" },
  { value: "clips", label: "Most clips" },
];

/**
 * FilterToolbar — the slim sticky command row that replaces the boxed filter
 * panel: search, compact filter + sort selects, and a grid/list view toggle.
 */
export function FilterToolbar({
  query,
  onQueryChange,
  status,
  onStatusChange,
  source,
  onSourceChange,
  sort,
  onSortChange,
  view,
  onViewChange,
  selectedCount,
  onClearSelection,
  selectionAction,
}: FilterToolbarProps) {
  const activeFilterCount =
    Number(query.trim().length > 0) + Number(status !== "all") + Number(source !== "all");

  return (
    <Collapsible.Root defaultOpen={activeFilterCount > 0}>
      <Stack gap="0" minW="0" w="full">
        <Flex gap="3" align="center" justify="space-between" wrap="wrap">
          <Text fontSize="13px" fontWeight="600" color="fg">
            Projects
          </Text>
          <Flex gap="2" w={{ base: "full", md: "auto" }} minW="0">
            {selectedCount > 0 ? (
              <>
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label="Clear project selection"
                  onClick={onClearSelection}
                >
                  <X size={13} />
                </IconButton>
                {selectionAction}
              </>
            ) : (
              <>
                <Collapsible.Trigger asChild>
                  <IconButton
                    size="sm"
                    variant={activeFilterCount > 0 ? "solid" : "outline"}
                    flexShrink={0}
                    aria-label={
                      activeFilterCount > 0
                        ? `Filters, ${activeFilterCount} active`
                        : "Filters"
                    }
                  >
                    <Filter size={13} aria-hidden="true" />
                  </IconButton>
                </Collapsible.Trigger>
                <SegmentedControl
                  size="sm"
                  flexShrink={0}
                  alignItems="center"
                  value={view}
                  onValueChange={(value) => onViewChange(value as ViewMode)}
                  aria-label="View mode"
                  items={[
                    {
                      value: "grid",
                      label: (
                        <>
                          <LayoutGrid size={13} aria-hidden="true" />
                          <VisuallyHidden>Grid view</VisuallyHidden>
                        </>
                      ),
                    },
                    {
                      value: "list",
                      label: (
                        <>
                          <Rows3 size={13} aria-hidden="true" />
                          <VisuallyHidden>List view</VisuallyHidden>
                        </>
                      ),
                    },
                  ]}
                />
              </>
            )}
          </Flex>
        </Flex>

        <Collapsible.Content>
          <Grid
            gap="2"
            pt="3"
            w="full"
            templateColumns={{
              base: "1fr",
              sm: "repeat(2, minmax(0, 1fr))",
              lg: "minmax(240px, 1fr) 132px 144px 152px",
            }}
          >
          <InputGroup color="fg.subtle" startElement={<Search size={13} />}>
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              placeholder="Search projects"
              aria-label="Search projects"
              size="sm"
              fontSize="13px"
            />
          </InputGroup>
          <Select
            items={STATUS_ITEMS}
            value={status}
            onValueChange={(value) => onStatusChange(value as StatusFilter)}
            size="sm"
            width="full"
            minW="0"
            aria-label="Filter by status"
          />
          <Select
            items={SOURCE_ITEMS}
            value={source}
            onValueChange={(value) => onSourceChange(value as SourceFilter)}
            size="sm"
            width="full"
            minW="0"
            aria-label="Filter by source"
          />
          <Select
            items={SORT_ITEMS}
            value={sort}
            onValueChange={(value) => onSortChange(value as SortOption)}
            size="sm"
            width="full"
            minW="0"
            aria-label="Sort projects"
          />
          </Grid>
        </Collapsible.Content>
      </Stack>
    </Collapsible.Root>
  );
}
