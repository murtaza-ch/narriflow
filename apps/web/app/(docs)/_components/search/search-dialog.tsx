"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Dialog, Flex, Input, Portal, Stack, Text } from "@chakra-ui/react";
import { Search, X } from "lucide-react";
import { IconButton } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import type { SearchHit } from "@/lib/docs/search-index";
import { highlightPattern, SearchResult } from "./search-result";

const optionId = (index: number) => `docs-search-option-${index}`;

const NO_HITS: SearchHit[] = [];

interface Outcome {
  query: string;
  hits: SearchHit[];
  failed: boolean;
}

/** Results for the typed query; a new query keeps showing the last results until its own arrive. */
function useDocsSearch(input: string) {
  const query = input.trim();
  const [outcome, setOutcome] = useState<Outcome>({ query: "", hits: NO_HITS, failed: false });

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/docs/search?query=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Search failed with ${response.status}`);
        setOutcome({ query, hits: (await response.json()) as SearchHit[], failed: false });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setOutcome({ query, hits: NO_HITS, failed: true });
      }
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return { query, hits: query ? outcome.hits : NO_HITS, loading: query !== "" && outcome.query !== query, failed: outcome.failed && outcome.query === query };
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <Stack align="center" gap="2" px="3" py="8">
      <Box color="fg.subtle">
        <Search size={20} />
      </Box>
      <Text textAlign="center" color="fg.muted" fontSize="13px">
        {children}
      </Text>
    </Stack>
  );
}

function SearchPanel({ close }: { close: () => void }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const { query, hits, loading, failed } = useDocsSearch(input);
  const [active, setActive] = useState(0);
  const [shown, setShown] = useState(hits);

  // A new list starts at its first result.
  if (shown !== hits) {
    setShown(hits);
    setActive(0);
  }

  const pattern = highlightPattern(query);

  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && hits.length > 0) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + hits.length) % hits.length);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing && hits[active]) {
      event.preventDefault();
      close();
      router.push(hits[active].url);
    }
  }

  return (
    <>
      <Dialog.Header p="3" pb="1">
        {/* The row is the soft field; the input inside stays transparent. */}
        <Flex w="full" h="10" align="center" gap="3" bg="bg.soft" borderRadius="control" px="3" pe="12" _focusWithin={{ boxShadow: "inset 0 0 0 1px var(--chakra-colors-border-focus)" }}>
          <Search size={17} />
          <Input
            flex="1"
            minW="0"
            h="10"
            bg="transparent"
            variant="flushed"
            borderRadius="0"
            border="0"
            boxShadow="none"
            autoFocus
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="docs-search-results"
            aria-autocomplete="list"
            aria-activedescendant={hits.length > 0 ? optionId(active) : undefined}
            aria-label="Search docs"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search docs…"
            _focus={{ boxShadow: "none" }}
            _focusVisible={{ boxShadow: "none", outline: "none" }}
          />
          {loading ? <Spinner size="xs" /> : null}
          <Dialog.CloseTrigger asChild top="4" insetEnd="4">
            <IconButton variant="ghost" size="sm" borderRadius="full" aria-label="Close search">
              <X size={16} />
            </IconButton>
          </Dialog.CloseTrigger>
        </Flex>
      </Dialog.Header>
      <Dialog.Body p="2" maxH="min(420px, 55dvh)" overflowY="auto" aria-live="polite">
        {!query ? (
          <Message>Search guides, assistant setup and the API reference.</Message>
        ) : failed ? (
          <Message>Search is unavailable. Try again in a moment.</Message>
        ) : hits.length > 0 ? (
          <Stack id="docs-search-results" role="listbox" aria-label="Results" gap="0.5">
            {hits.map((hit, index) => (
              <SearchResult
                key={hit.url}
                hit={hit}
                id={optionId(index)}
                active={index === active}
                pattern={pattern}
                onHover={() => setActive(index)}
                onSelect={close}
              />
            ))}
          </Stack>
        ) : !loading ? (
          <Message>No results for “{query}”.</Message>
        ) : null}
      </Dialog.Body>
    </>
  );
}

export function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={(details) => onOpenChange(details.open)} placement="top" lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner pt={{ base: "4", md: "12vh" }}>
          <Dialog.Content maxW="620px" overflow="hidden" aria-label="Search docs">
            <SearchPanel close={() => onOpenChange(false)} />
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
