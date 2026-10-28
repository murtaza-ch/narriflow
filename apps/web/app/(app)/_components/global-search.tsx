"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Dialog, Flex, Input, Portal, Stack, Text } from "@chakra-ui/react";
import { Captions, Folder, History, type LucideIcon, Search, SearchX, Video } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Bone } from "@narriflow/ui/components/page-loading";
import {
  matchNavigationActions,
  type NavigationAction,
} from "@/lib/navigation-actions";

type SearchResult = {
  id: string;
  type: "project" | "folder" | "clip";
  title: string;
  subtitle: string | null;
  href: string;
};

const TYPE_META = {
  project: { label: "Projects", icon: Video },
  folder: { label: "Folders", icon: Folder },
  clip: { label: "Clips", icon: Captions },
} as const;

/** A key cap: the hint beside a shortcut, never a control of its own. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <Flex
      as="kbd"
      align="center"
      justify="center"
      h="5"
      minW="5"
      px="1.5"
      borderRadius="6px"
      bg="bg.softHover"
      color="fg.muted"
      fontFamily="inherit"
      fontSize="11px"
      fontWeight="500"
      lineHeight="1"
    >
      {children}
    </Flex>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <Text textStyle="eyebrow" color="fg.muted" px="3" pt="3" pb="1.5" aria-hidden>
      {children}
    </Text>
  );
}

/** One row of the palette: an icon tile, a title and a line, and ↵ on the active row. */
function Row({
  id,
  icon: Icon,
  title,
  subtitle,
  active,
  selectable = true,
  onHover,
  onSelect,
}: {
  id?: string;
  icon: LucideIcon;
  title: string;
  subtitle?: string | null;
  active: boolean;
  /** A listbox option the arrow keys reach; recent searches are plain buttons. */
  selectable?: boolean;
  onHover?: () => void;
  onSelect: () => void;
}) {
  return (
    <Flex
      as="button"
      id={id}
      role={selectable ? "option" : undefined}
      aria-selected={selectable ? active : undefined}
      w="full"
      align="center"
      gap="3"
      px="2"
      py="2"
      borderRadius="l2"
      bg={active ? "bg.soft" : "transparent"}
      cursor="pointer"
      textAlign="left"
      _hover={selectable ? undefined : { bg: "bg.soft" }}
      onMouseEnter={onHover}
      onClick={onSelect}
    >
      <Flex
        boxSize="8"
        flexShrink={0}
        align="center"
        justify="center"
        borderRadius="8px"
        bg={active ? "accent.subtle" : "bg.soft"}
        color={active ? "accent.fg" : "fg.muted"}
        transition="background 120ms ease, color 120ms ease"
      >
        <Icon size={16} />
      </Flex>
      <Stack gap="0" minW="0" flex="1">
        <Text fontSize="14px" fontWeight="500" truncate>
          {title}
        </Text>
        {subtitle ? (
          <Text fontSize="12px" color="fg.subtle" truncate>
            {subtitle}
          </Text>
        ) : null}
      </Stack>
      {active && selectable ? <Kbd>↵</Kbd> : null}
    </Flex>
  );
}

/** Placeholder rows while a search is on its way. */
function SearchingRows() {
  return (
    <Box aria-hidden>
      <GroupLabel>Searching…</GroupLabel>
      {[0, 1, 2].map((row) => (
        <Flex key={row} align="center" gap="3" px="2" py="2">
          <Bone boxSize="8" borderRadius="8px" />
          <Stack gap="1.5" flex="1">
            <Bone h="3.5" w={row === 1 ? "44" : "56"} maxW="70%" />
            <Bone h="3" w="28" maxW="50%" />
          </Stack>
        </Flex>
      ))}
    </Box>
  );
}

export function GlobalSearch({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  // The list follows the arrow keys, not the pointer: a hovered row stays put.
  const followActive = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(`narriflow:recent-searches:${workspaceId}`);
      setRecentSearches(stored ? (JSON.parse(stored) as string[]).slice(0, 5) : []);
    } catch {
      setRecentSearches([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/workspace/search?q=${encodeURIComponent(normalized)}`, {
          signal: controller.signal,
        });
        const body = (await response.json()) as { results?: SearchResult[] };
        setResults(response.ok ? (body.results ?? []) : []);
        setActiveIndex(0);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setResults([]);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // A new query starts the list from its top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query is the trigger, not a value read here.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [query]);

  useEffect(() => {
    if (!followActive.current) return;
    followActive.current = false;
    document.getElementById(`search-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const grouped = useMemo(
    () => (["project", "folder", "clip"] as const).map((type) => ({
      type,
      items: results.filter((result) => result.type === type),
    })).filter((group) => group.items.length > 0),
    [results],
  );
  const actionResults = useMemo(() => matchNavigationActions(query), [query]);
  const selectableResults = useMemo(
    () => [
      ...actionResults.map((action) => ({ kind: "action" as const, action })),
      ...results.map((result) => ({ kind: "workspace" as const, result })),
    ],
    [actionResults, results],
  );

  function navigate(href: string) {
    const normalized = query.trim();
    if (normalized.length >= 2) {
      const next = [normalized, ...recentSearches.filter((item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase())].slice(0, 5);
      setRecentSearches(next);
      window.localStorage.setItem(`narriflow:recent-searches:${workspaceId}`, JSON.stringify(next));
    }
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  function choose(result: SearchResult) {
    navigate(result.href);
  }

  function chooseAction(action: NavigationAction) {
    navigate(action.href);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = Math.min(selectableResults.length - 1, activeIndex + 1);
      followActive.current = next !== activeIndex;
      setActiveIndex(next);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.max(0, activeIndex - 1);
      followActive.current = next !== activeIndex;
      setActiveIndex(next);
    } else if (event.key === "Enter" && selectableResults[activeIndex]) {
      event.preventDefault();
      const selected = selectableResults[activeIndex];
      if (selected.kind === "action") chooseAction(selected.action);
      else choose(selected.result);
    }
  }

  const searching = query.trim().length >= 2;
  const noMatches = searching && !loading && results.length === 0 && actionResults.length === 0;

  const actionRows = actionResults.map((action, index) => (
    <Row
      key={action.id}
      id={`search-option-${index}`}
      icon={action.icon}
      title={action.title}
      subtitle={action.subtitle}
      active={index === activeIndex}
      onHover={() => setActiveIndex(index)}
      onSelect={() => chooseAction(action)}
    />
  ));

  return (
    <Dialog.Root open={open} onOpenChange={(details) => setOpen(details.open)} placement="top">
      <Dialog.Trigger asChild>
        <Flex
          as="button"
          aria-label="Search workspace"
          align="center"
          gap="2"
          h="8"
          px="3"
          minW={{ lg: "240px" }}
          borderRadius="l1"
          bg="bg.soft"
          color="fg.muted"
          cursor="pointer"
          transition="background 120ms ease, color 120ms ease"
          _hover={{ bg: "bg.softHover", color: "fg" }}
        >
          <Search size={14} />
          <Text fontSize="12px" flex="1" textAlign="left">Search workspace</Text>
          <Kbd>⌘K</Kbd>
        </Flex>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner pt="12vh">
          <Dialog.Content maxW="640px" overflow="hidden" aria-label="Search workspace">
            <Dialog.Header p="3" pb="1">
              {/* The row is the soft field; the input inside stays transparent. */}
              <Flex
                w="full"
                h="12"
                align="center"
                gap="3"
                bg="bg.soft"
                borderRadius="control"
                borderWidth="1px"
                borderColor="transparent"
                px="4"
                pe="3"
                transition="border-color 120ms ease"
                _focusWithin={{ borderColor: "border.focus" }}
              >
                <Box color="fg.muted" flexShrink={0}><Search size={18} /></Box>
                <Input
                  flex="1"
                  minW="0"
                  bg="transparent"
                  variant="flushed"
                  borderRadius="0"
                  autoFocus
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={onInputKeyDown}
                  placeholder="Search projects, clips, integrations, and help…"
                  role="combobox"
                  aria-expanded={!noMatches}
                  aria-controls={noMatches ? undefined : "search-listbox"}
                  aria-activedescendant={selectableResults[activeIndex] ? `search-option-${activeIndex}` : undefined}
                  border="0"
                  boxShadow="none"
                  h="12"
                  fontSize="16px"
                  _focus={{ boxShadow: "none" }}
                  _focusVisible={{ boxShadow: "none", outline: "none" }}
                />
                {loading ? <Spinner size="xs" /> : null}
                <Dialog.CloseTrigger asChild position="static" top="auto" insetEnd="auto">
                  <Flex
                    as="button"
                    aria-label="Close search (Esc)"
                    h="6"
                    px="2"
                    flexShrink={0}
                    align="center"
                    borderRadius="6px"
                    bg="bg.softHover"
                    color="fg.muted"
                    fontSize="11px"
                    fontWeight="500"
                    cursor="pointer"
                    transition="color 120ms ease"
                    _hover={{ color: "fg" }}
                  >
                    esc
                  </Flex>
                </Dialog.CloseTrigger>
              </Flex>
            </Dialog.Header>
            <Dialog.Body ref={bodyRef} p="2" pt="1" maxH="min(400px, 55vh)" overflowY="auto" aria-live="polite" style={{ scrollPaddingBlock: 8 }}>
              {!searching ? (
                <Stack gap="0">
                  <Box id="search-listbox" role="listbox" aria-label="Go to">
                    <GroupLabel>Go to</GroupLabel>
                    {actionRows}
                  </Box>
                  {/* Plain buttons, so they sit outside the listbox. */}
                  {recentSearches.length > 0 ? (
                    <Box role="group" aria-label="Recent searches">
                      <GroupLabel>Recent searches</GroupLabel>
                      {recentSearches.map((recent) => (
                        <Row key={recent} icon={History} title={recent} active={false} selectable={false} onSelect={() => setQuery(recent)} />
                      ))}
                    </Box>
                  ) : null}
                </Stack>
              ) : noMatches ? (
                <Stack align="center" gap="3" px="3" py="10">
                  <Flex boxSize="11" align="center" justify="center" borderRadius="full" bg="bg.soft" color="fg.muted">
                    <SearchX size={20} />
                  </Flex>
                  <Stack align="center" gap="0.5">
                    <Text textAlign="center" fontSize="14px" fontWeight="500" maxW="full" truncate>
                      No results for “{query.trim()}”
                    </Text>
                    <Text textAlign="center" color="fg.muted" fontSize="13px">
                      Try a different word, or check the spelling.
                    </Text>
                  </Stack>
                </Stack>
              ) : (
                <Stack gap="0" id="search-listbox" role="listbox" aria-label="Search results">
                  {actionResults.length > 0 ? (
                    <Box role="group" aria-label="Actions and guides">
                      <GroupLabel>Actions &amp; guides</GroupLabel>
                      {actionRows}
                    </Box>
                  ) : null}
                  {loading && results.length === 0 ? <SearchingRows /> : null}
                  {grouped.map((group) => (
                    <Box key={group.type} role="group" aria-label={TYPE_META[group.type].label}>
                      <GroupLabel>{TYPE_META[group.type].label}</GroupLabel>
                      {group.items.map((result) => {
                        const index = actionResults.length + results.findIndex((item) => item.id === result.id && item.type === result.type);
                        return (
                          <Row
                            key={`${result.type}:${result.id}`}
                            id={`search-option-${index}`}
                            icon={TYPE_META[result.type].icon}
                            title={result.title}
                            subtitle={result.subtitle}
                            active={index === activeIndex}
                            onHover={() => setActiveIndex(index)}
                            onSelect={() => choose(result)}
                          />
                        );
                      })}
                    </Box>
                  ))}
                </Stack>
              )}
            </Dialog.Body>
            {/* Footer: the keys, on a quiet band (a step darker than the dialog, no rule). */}
            <Flex display={{ base: "none", md: "flex" }} align="center" gap="4" px="4" py="2.5" bg="bg.subtle" color="fg.subtle" fontSize="12px" aria-hidden>
              <Flex align="center" gap="1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd>Navigate</Flex>
              <Flex align="center" gap="1.5"><Kbd>↵</Kbd>Open</Flex>
              <Flex align="center" gap="1.5"><Kbd>esc</Kbd>Close</Flex>
            </Flex>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
