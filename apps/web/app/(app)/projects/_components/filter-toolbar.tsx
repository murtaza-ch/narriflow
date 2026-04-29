"use client";

import {
  createListCollection,
  Flex,
  HStack,
  Input,
  InputGroup,
  Portal,
  SegmentGroup,
  Select,
  Text,
} from "@chakra-ui/react";
import { Search } from "lucide-react";
import type {
  SourceFilter,
  SortOption,
  StatusFilter,
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
  resultCount: number;
  totalCount: number;
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
  { value: "upload", label: "Upload" },
  { value: "rss", label: "RSS" },
];

const sortCollection = createListCollection<{
  value: SortOption;
  label: string;
}>({
  items: [
    { value: "newest", label: "Newest first" },
    { value: "oldest", label: "Oldest first" },
    { value: "title", label: "Title A→Z" },
    { value: "clips", label: "Most clips" },
  ],
});

export function FilterToolbar({
  query,
  onQueryChange,
  status,
  onStatusChange,
  source,
  onSourceChange,
  sort,
  onSortChange,
  resultCount,
  totalCount,
}: FilterToolbarProps) {
  return (
    <Flex
      direction="column"
      gap="14px"
      p="16px"
      borderRadius="14px"
      borderWidth="1px"
      borderColor="border"
      bg="bg.subtle"
    >
      <Flex
        direction={{ base: "column", md: "row" }}
        align={{ base: "stretch", md: "center" }}
        justify="space-between"
        gap="12px"
      >
        <InputGroup
          maxW={{ md: "340px" }}
          flex={{ md: "0 0 auto" }}
          startElement={<Search size={14} />}
        >
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder="Search projects"
            size="sm"
            variant="subtle"
            bg="bg.panel"
            borderColor="border"
            fontSize="13px"
          />
        </InputGroup>

        <HStack gap="12px" align="center">
          <Text
            fontFamily="mono"
            fontSize="11px"
            color="fg.subtle"
            letterSpacing="0.04em"
          >
            {resultCount} of {totalCount}
          </Text>

          <Select.Root
            collection={sortCollection}
            size="sm"
            width="170px"
            value={[sort]}
            onValueChange={(event) => {
              const next = event.value[0] as SortOption | undefined;
              if (next) onSortChange(next);
            }}
            positioning={{ sameWidth: true }}
          >
            <Select.HiddenSelect />
            <Select.Control>
              <Select.Trigger
                bg="bg.panel"
                borderColor="border"
                fontFamily="mono"
                fontSize="12px"
              >
                <Select.ValueText placeholder="Sort" />
              </Select.Trigger>
              <Select.IndicatorGroup>
                <Select.Indicator />
              </Select.IndicatorGroup>
            </Select.Control>
            <Portal>
              <Select.Positioner>
                <Select.Content
                  bg="bg.panel"
                  borderColor="border"
                  borderWidth="1px"
                  shadow="lg"
                >
                  {sortCollection.items.map((item) => (
                    <Select.Item
                      key={item.value}
                      item={item}
                      fontSize="12px"
                      fontFamily="mono"
                    >
                      <Select.ItemText>{item.label}</Select.ItemText>
                      <Select.ItemIndicator />
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Portal>
          </Select.Root>
        </HStack>
      </Flex>

      <Flex
        direction={{ base: "column", lg: "row" }}
        gap="12px"
        align={{ lg: "center" }}
        justify="space-between"
      >
        <SegmentGroup.Root
          size="xs"
          value={status}
          onValueChange={(event) => {
            if (event.value) onStatusChange(event.value as StatusFilter);
          }}
          bg="bg.panel"
          borderWidth="1px"
          borderColor="border"
        >
          <SegmentGroup.Indicator />
          <SegmentGroup.Items items={STATUS_ITEMS} />
        </SegmentGroup.Root>

        <SegmentGroup.Root
          size="xs"
          value={source}
          onValueChange={(event) => {
            if (event.value) onSourceChange(event.value as SourceFilter);
          }}
          bg="bg.panel"
          borderWidth="1px"
          borderColor="border"
        >
          <SegmentGroup.Indicator />
          <SegmentGroup.Items items={SOURCE_ITEMS} />
        </SegmentGroup.Root>
      </Flex>
    </Flex>
  );
}
