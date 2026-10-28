"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Box, chakra, Flex, Skeleton, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, Quote, RotateCw, Scissors, Search, SearchX, Sparkles } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import SearchLoading from "./loading";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import { clipCommands, invalidateAfterClipChange } from "@narriflow/api-client/clips";
import { type LibrarySearchData, libraryQueries } from "@narriflow/api-client/library";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDuration } from "@/lib/format";
import { useWorkspaceBootstrap } from "../_components/usage";
import { failureMessage, type LibraryApi, useLibraryApi } from "../projects/_lib/api";

type LibraryPassage = LibrarySearchData["results"][number];

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; query: string; results: LibraryPassage[] };

const SEARCH_FAILURE = "Something went wrong. Please try again.";
const MAX_QUERY_LENGTH = 300;

const EXAMPLES = ["What did we say about pricing?", "a funny story", "our biggest mistake", "advice for beginners"];

/** The query's words (3+ letters) marked in a passage, so a result shows why it matched. */
function highlight(text: string, query: string): ReactNode {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [])];
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  return text.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      <chakra.mark key={index} bg="accent.subtle" color="fg" borderRadius="3px" px="0.5">
        {part}
      </chakra.mark>
    ) : (
      part
    ),
  );
}

export function LibrarySearch() {
  const api = useLibraryApi();
  return api ? <SearchContent api={api} /> : <SearchLoading />;
}

function SearchContent({ api }: { api: LibraryApi }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const initialQuery = useSearchParams().get("q")?.slice(0, MAX_QUERY_LENGTH) ?? "";
  const [query, setQuery] = useState(initialQuery);
  // A shared link opens with its results.
  const [submitted, setSubmitted] = useState<string | null>(
    initialQuery.trim().length >= 2 ? initialQuery.trim() : null,
  );
  const [creating, setCreating] = useState<string | null>(null);
  const [tooShort, setTooShort] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const results = useQuery({
    ...libraryQueries.search(api.library, api.scope, { q: submitted ?? "" }),
    enabled: submitted !== null,
  });
  // Making a clip needs the same capability as the endpoint; the shell already loaded it.
  const canCreate = useWorkspaceBootstrap(api.scope).data?.capabilities["content.edit"] ?? false;
  // One intent for the clip being made: a retry replays it instead of making a second clip.
  const [clipIntent] = useState(() => api.runtime.createIntent<{ projectId: string; startSec: number; endSec: number }>());

  const state = ((): SearchState => {
    if (submitted === null) return { status: "idle" };
    if (results.data) return { status: "done", query: submitted, results: results.data.results };
    if (results.isError && !results.isFetching) {
      return { status: "error", message: failureMessage(results.error, SEARCH_FAILURE) };
    }
    return { status: "loading" };
  })();

  function search(text: string) {
    const normalized = text.trim();
    // The button stays live; a too-short query says why instead of greying it out.
    setTooShort(normalized.length < 2);
    if (normalized.length < 2) {
      input.current?.focus();
      return;
    }
    router.replace(`/search?q=${encodeURIComponent(normalized)}`, { scroll: false });
    if (normalized === submitted) void results.refetch();
    else setSubmitted(normalized);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    search(query);
  }

  const makeClip = useMutation({
    retry: false,
    mutationFn: async (passage: LibraryPassage) => {
      const range = { startSec: passage.startMs / 1000, endSec: passage.endMs / 1000 };
      const clip = await clipCommands.createFromRange(
        api.clips,
        passage.projectId,
        range,
        clipIntent.keyFor({ projectId: passage.projectId, ...range }),
      );
      clipIntent.complete();
      return { projectId: passage.projectId, clipId: clip.id };
    },
    onSuccess: ({ projectId, clipId }) => {
      router.push(`/projects/${projectId}/clips/${clipId}/studio`);
      void invalidateAfterClipChange(queryClient, api.scope, projectId);
    },
    onError: (error) =>
      toaster.create({ type: "error", title: "Could not create the clip", description: failureMessage(error, "Network error. Please try again.") }),
    onSettled: () => setCreating(null),
  });

  function startClip(passage: LibraryPassage) {
    setCreating(`${passage.projectId}:${passage.startMs}`);
    makeClip.mutate(passage);
  }

  const runExample = (example: string) => {
    setQuery(example);
    search(example);
  };

  return (
    <Stack gap="8">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader title="Search" description="Find any moment across your transcripts, by meaning or exact words." />
      </Box>

      <Stack gap="3" animation="fade-up" animationDelay="60ms" animationFillMode="backwards">
        <Box as="form" role="search" onSubmit={submit}>
          <Flex
            align="center"
            gap="3"
            h="14"
            ps="4"
            pe="2"
            bg="bg.subtle"
            borderRadius="l3"
            borderWidth="1px"
            borderColor="transparent"
            transition="border-color 120ms ease, background 120ms ease"
            _focusWithin={{ borderColor: "border.focus", bg: "bg.soft" }}
          >
            <Box color="fg.muted" flexShrink={0}>
              <Search size={18} aria-hidden />
            </Box>
            <chakra.input
              ref={input}
              aria-label="Search your library"
              placeholder="Describe a moment, or type words that were said"
              value={query}
              maxLength={300}
              onChange={(event) => {
                setQuery(event.target.value);
                if (tooShort) setTooShort(false);
              }}
              flex="1"
              minW="0"
              h="full"
              bg="transparent"
              fontSize="15px"
              color="fg"
              outline="none"
              _placeholder={{ color: "fg.subtle" }}
            />
            <Button type="submit" loading={state.status === "loading"} flexShrink={0}>
              Search <ArrowRight size={14} aria-hidden />
            </Button>
          </Flex>
        </Box>
        <Flex align="center" gap="2" wrap="wrap" minH="7">
          {tooShort ? (
            <Text fontSize="12.5px" color="fg.muted">
              Type at least 2 characters.
            </Text>
          ) : (
            <>
              <Hint icon={<Sparkles size={12} />}>Matches meaning</Hint>
              <Hint icon={<Quote size={12} />}>Also matches the words you type</Hint>
            </>
          )}
        </Flex>
      </Stack>

      <Box aria-live="polite" animation="fade-up" animationDelay="120ms" animationFillMode="backwards">
        {state.status === "idle" ? (
          <Stack align="center" gap="5" py={{ base: "10", md: "14" }} px="6" bg="bg.subtle" borderRadius="l3" textAlign="center">
            <Flex boxSize="12" borderRadius="full" bg="bg.soft" color="fg.muted" align="center" justify="center">
              <Search size={20} strokeWidth={1.75} />
            </Flex>
            <Stack gap="1">
              <Text fontSize="15px" fontWeight="500">
                Search your library
              </Text>
              <Text fontSize="13px" color="fg.muted">
                Results jump to the exact moment, ready to turn into a clip.
              </Text>
            </Stack>
            <Flex gap="2" wrap="wrap" justify="center">
              {EXAMPLES.map((example) => (
                <chakra.button
                  key={example}
                  type="button"
                  onClick={() => runExample(example)}
                  h="8"
                  px="3"
                  borderRadius="full"
                  bg="bg.soft"
                  color="fg"
                  fontSize="12.5px"
                  cursor="pointer"
                  transition="background 120ms ease"
                  _hover={{ bg: "bg.softHover" }}
                >
                  {example}
                </chakra.button>
              ))}
            </Flex>
          </Stack>
        ) : state.status === "loading" ? (
          <Stack gap="2" aria-label="Searching">
            {[0, 1, 2].map((row) => (
              <Stack key={row} gap="2.5" p="5" bg="bg.subtle" borderRadius="l3">
                <Skeleton h="3" w="40" borderRadius="full" />
                <Skeleton h="3" w="full" borderRadius="full" />
                <Skeleton h="3" w="70%" borderRadius="full" />
              </Stack>
            ))}
          </Stack>
        ) : state.status === "error" ? (
          <EmptyState
            icon={<SearchX size={20} strokeWidth={1.75} />}
            title="Search is unavailable"
            description={state.message}
            action={
              <Button size="sm" variant="subtle" onClick={() => search(query)}>
                <RotateCw size={13} aria-hidden /> Try again
              </Button>
            }
          />
        ) : state.results.length === 0 ? (
          <EmptyState
            icon={<SearchX size={20} strokeWidth={1.75} />}
            title="No matching moments"
            description="Only projects with a finished transcript can be searched. New transcripts appear within a minute or two."
          />
        ) : (
          <Stack gap="3">
            <Text fontSize="13px" color="fg.muted">
              {state.results.length} {state.results.length === 1 ? "moment" : "moments"} for “{state.query}”
            </Text>
            <Stack as="ul" gap="2" listStyleType="none" m="0" p="0">
              {state.results.map((passage) => {
                const key = `${passage.projectId}:${passage.startMs}`;
                return (
                  <Flex as="li" key={key} gap="4" align="flex-start" p="5" borderRadius="l3" bg="bg.subtle">
                    <Flex
                      flexShrink={0}
                      h="7"
                      px="2"
                      align="center"
                      borderRadius="8px"
                      bg="bg.soft"
                      textStyle="data"
                      fontSize="12px"
                      color="fg.timecode"
                    >
                      {formatDuration(passage.startMs / 1000)}
                    </Flex>
                    <Stack gap="1.5" flex="1" minW="0">
                      <Flex align="baseline" gap="2" minW="0">
                        <Link href={`/projects/${passage.projectId}`}>
                          <Text fontSize="13.5px" fontWeight="500" color="fg" truncate _hover={{ textDecoration: "underline", textUnderlineOffset: "3px" }}>
                            {passage.projectTitle}
                          </Text>
                        </Link>
                        <Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums" flexShrink={0}>
                          {formatDuration(passage.startMs / 1000)} to {formatDuration(passage.endMs / 1000)}
                        </Text>
                      </Flex>
                      <Text fontSize="14px" color="fg.muted" lineHeight="1.6" lineClamp={4}>
                        {highlight(passage.text, state.query)}
                      </Text>
                    </Stack>
                    {canCreate ? (
                      <Button size="sm" variant="subtle" flexShrink={0} disabled={creating !== null} onClick={() => startClip(passage)}>
                        {creating === key ? <Spinner size="xs" /> : <Scissors size={13} aria-hidden />}
                        Make a clip
                      </Button>
                    ) : null}
                  </Flex>
                );
              })}
            </Stack>
          </Stack>
        )}
      </Box>
    </Stack>
  );
}

function Hint({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Flex align="center" gap="1.5" h="7" px="2.5" borderRadius="full" bg="bg.subtle" fontSize="12px" color="fg.muted">
      {icon}
      {children}
    </Flex>
  );
}
