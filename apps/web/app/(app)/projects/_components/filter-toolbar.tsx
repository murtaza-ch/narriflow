"use client";

import {
  Box,
  HStack,
  Input,
  InputGroup,
  Text,
  VisuallyHidden,
} from "@chakra-ui/react";
import { LayoutGrid, Rows3, Search } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Select } from "@narriflow/ui/components/select";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Toolbar } from "@narriflow/ui/components/toolbar";
import type {
  SourceFilter,
  SortOption,
  StatusFilter,
  ViewMode,
} from "./projects-explorer";

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
  /** Per-status counts among the loaded projects (source + search applied). */
  statusCounts: Record<StatusFilter, number>;
  /** Projects visible after all filters. */
  resultCount: number;
  /** Projects loaded from the server so far — the honest denominator. */
  loadedCount: number;
}

const STATUS_ITEMS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
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
 * panel: search, status chips with live mono counts, compact source + sort
 * selects, and a grid/list view toggle.
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
  statusCounts,
  resultCount,
  loadedCount,
}: FilterToolbarProps) {
  return (
    <Toolbar h="auto" minH="12" py="2" flexWrap="wrap" gap="2" columnGap="3">
      <InputGroup
        w={{ base: "full", md: "220px" }}
        flexShrink={0}
        color="fg.subtle"
        startElement={<Search size={13} />}
      >
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="Search projects"
          aria-label="Search projects"
          size="sm"
          // Pin to the shared 32px toolbar control height (sm recipe is
          // 36px); the var also drives the InputGroup icon inset.
          css={{ "--input-height": "sizes.8" }}
          fontSize="13px"
        />
      </InputGroup>

      <HStack gap="1" flexWrap="wrap" role="group" aria-label="Filter by status">
        {STATUS_ITEMS.map((item) => (
          <StatusChip
            key={item.value}
            label={item.label}
            count={statusCounts[item.value]}
            active={status === item.value}
            danger={item.value === "failed"}
            onClick={() => onStatusChange(item.value)}
          />
        ))}
      </HStack>

      <Box flex="1" minW="2" />

      <Text
        textStyle="data"
        fontSize="11px"
        color="fg.subtle"
        flexShrink={0}
        aria-live="polite"
      >
        {resultCount} of {loadedCount} shown
      </Text>

      <HStack gap="2" flexShrink={0}>
        <Select
          items={SOURCE_ITEMS}
          value={source}
          onValueChange={(value) => onSourceChange(value as SourceFilter)}
          size="sm"
          width="128px"
          aria-label="Filter by source"
        />
        <Select
          items={SORT_ITEMS}
          value={sort}
          onValueChange={(value) => onSortChange(value as SortOption)}
          size="sm"
          width="136px"
          aria-label="Sort projects"
        />
        <SegmentedControl
          size="sm"
          // Match the 32px control row (sm track is ~30px on its own).
          h="8"
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
      </HStack>
    </Toolbar>
  );
}

function StatusChip({
  label,
  count,
  active,
  danger,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={onClick}
      aria-pressed={active}
      px="2"
      gap="1.5"
      color={active ? "fg" : "fg.muted"}
      bg={active ? "bg.muted" : "transparent"}
      fontWeight={active ? "600" : "500"}
      _hover={{ bg: active ? "bg.muted" : "bg.subtle", color: "fg" }}
    >
      {label}
      <Text
        as="span"
        textStyle="data"
        fontSize="11px"
        color={danger && count > 0 ? "danger.fg" : active ? "fg.muted" : "fg.subtle"}
      >
        {count}
      </Text>
    </Button>
  );
}
