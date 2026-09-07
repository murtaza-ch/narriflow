"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Dialog, Flex, Input, Portal, Stack, Text } from "@chakra-ui/react";
import { Captions, Folder, Search, Video, X } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
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

export function GlobalSearch({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

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
      setActiveIndex((index) => Math.min(selectableResults.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" && selectableResults[activeIndex]) {
      event.preventDefault();
      const selected = selectableResults[activeIndex];
      if (selected.kind === "action") chooseAction(selected.action);
      else choose(selected.result);
    }
  }

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
          color="fg.muted"
          cursor="pointer"
          _hover={{ borderColor: "border.emphasized", color: "fg" }}
        >
          <Search size={14} />
          <Text fontSize="12px" flex="1" textAlign="left">Search workspace</Text>
          <Text as="kbd" fontSize="11px" color="fg.subtle" borderWidth="1px" borderColor="border" borderRadius="4px" px="1">⌘K</Text>
        </Flex>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner pt="12vh">
          <Dialog.Content maxW="620px" overflow="hidden" aria-label="Search workspace">
            <Dialog.Header p="0">
              <Flex w="full" align="center" gap="3" borderBottomWidth="1px" borderColor="border.subtle" px="4" pe="12">
                <Search size={17} />
                <Input
                  flex="1"
                  minW="0"
                  bg="transparent"
                  variant="flushed"
                  borderRadius="0"
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={onInputKeyDown}
                  placeholder="Search projects, clips, integrations, and help…"
                  border="0"
                  boxShadow="none"
                  h="14"
                  _focus={{ boxShadow: "none" }}
                />
                {loading ? <Spinner size="xs" /> : null}
                <Dialog.CloseTrigger asChild>
                  <Flex as="button" aria-label="Close search" p="2" color="fg.muted"><X size={15} /></Flex>
                </Dialog.CloseTrigger>
              </Flex>
            </Dialog.Header>
            <Dialog.Body p="2" maxH="420px" overflowY="auto" aria-live="polite">
              {query.trim().length < 2 ? (
                <Stack gap="2">
                  <Box>
                    <Text textStyle="eyebrow" color="fg.subtle" px="3" py="2">Go to</Text>
                    {actionResults.map((action, index) => {
                      const Icon = action.icon;
                      return (
                        <Flex
                          as="button"
                          key={action.id}
                          w="full"
                          align="center"
                          gap="3"
                          px="3"
                          py="2.5"
                          borderRadius="l2"
                          bg={index === activeIndex ? "bg.subtle" : "transparent"}
                          textAlign="left"
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => chooseAction(action)}
                        >
                          <Icon size={15} />
                          <Stack gap="0" minW="0">
                            <Text fontSize="13px" fontWeight="550">{action.title}</Text>
                            <Text fontSize="12px" color="fg.subtle" truncate>{action.subtitle}</Text>
                          </Stack>
                        </Flex>
                      );
                    })}
                  </Box>
                  {recentSearches.length > 0 ? (
                    <Box>
                      <Text textStyle="eyebrow" color="fg.subtle" px="3" py="2">Recent searches</Text>
                    {recentSearches.map((recent) => (
                      <Flex
                        as="button"
                        key={recent}
                        w="full"
                        align="center"
                        gap="3"
                        px="3"
                        py="2.5"
                        borderRadius="l2"
                        textAlign="left"
                        _hover={{ bg: "bg.subtle" }}
                        onClick={() => setQuery(recent)}
                      >
                        <Search size={14} />
                        <Text fontSize="13px">{recent}</Text>
                      </Flex>
                    ))}
                    </Box>
                  ) : null}
                </Stack>
              ) : !loading && results.length === 0 && actionResults.length === 0 ? (
                <Text px="3" py="8" textAlign="center" color="fg.muted" fontSize="13px">
                  No matching workspace content or destinations.
                </Text>
              ) : (
                <Stack gap="2">
                  {actionResults.length > 0 ? (
                    <Box>
                      <Text textStyle="eyebrow" color="fg.subtle" px="3" py="2">Actions &amp; guides</Text>
                      {actionResults.map((action, index) => {
                        const Icon = action.icon;
                        return (
                          <Flex
                            as="button"
                            key={action.id}
                            w="full"
                            align="center"
                            gap="3"
                            px="3"
                            py="2.5"
                            borderRadius="l2"
                            bg={index === activeIndex ? "bg.subtle" : "transparent"}
                            textAlign="left"
                            onMouseEnter={() => setActiveIndex(index)}
                            onClick={() => chooseAction(action)}
                          >
                            <Icon size={15} />
                            <Stack gap="0" minW="0">
                              <Text fontSize="13px" fontWeight="550">{action.title}</Text>
                              <Text fontSize="12px" color="fg.subtle" truncate>{action.subtitle}</Text>
                            </Stack>
                          </Flex>
                        );
                      })}
                    </Box>
                  ) : null}
                  {grouped.map((group) => (
                    <Box key={group.type}>
                      <Text textStyle="eyebrow" color="fg.subtle" px="3" py="2">
                        {TYPE_META[group.type].label}
                      </Text>
                      {group.items.map((result) => {
                        const index = actionResults.length + results.findIndex((item) => item.id === result.id && item.type === result.type);
                        const Icon = TYPE_META[result.type].icon;
                        return (
                          <Flex
                            as="button"
                            key={`${result.type}:${result.id}`}
                            w="full"
                            align="center"
                            gap="3"
                            px="3"
                            py="2.5"
                            borderRadius="l2"
                            bg={index === activeIndex ? "bg.subtle" : "transparent"}
                            textAlign="left"
                            onMouseEnter={() => setActiveIndex(index)}
                            onClick={() => choose(result)}
                          >
                            <Icon size={15} />
                            <Stack gap="0" minW="0">
                              <Text fontSize="13px" fontWeight="550" truncate>{result.title}</Text>
                              {result.subtitle ? <Text fontSize="11px" color="fg.subtle" truncate>{result.subtitle}</Text> : null}
                            </Stack>
                          </Flex>
                        );
                      })}
                    </Box>
                  ))}
                </Stack>
              )}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
