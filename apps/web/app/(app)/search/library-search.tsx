"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Scissors, Search, SearchX } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Input } from "@narriflow/ui/components/input";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import { userErrorMessage, type LibraryPassage } from "@narriflow/validators";
import { formatDuration } from "@/lib/format";

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; query: string; results: LibraryPassage[] };

async function failureMessage(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return userErrorMessage(payload?.error) ?? payload?.message ?? "Something went wrong. Please try again.";
}

export function LibrarySearch({ initialQuery, canCreate }: { initialQuery: string; canCreate: boolean }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const [creating, setCreating] = useState<string | null>(null);
  const latest = useRef(0);

  async function search(text: string) {
    const normalized = text.trim();
    if (normalized.length < 2) return;
    const request = ++latest.current;
    setState({ status: "loading" });
    router.replace(`/search?q=${encodeURIComponent(normalized)}`, { scroll: false });
    try {
      const response = await fetch(`/api/library/search?q=${encodeURIComponent(normalized)}`);
      if (request !== latest.current) return;
      if (!response.ok) {
        setState({ status: "error", message: await failureMessage(response) });
        return;
      }
      const body = (await response.json()) as { results: LibraryPassage[] };
      setState({ status: "done", query: normalized, results: body.results });
    } catch {
      if (request === latest.current) setState({ status: "error", message: "Network error. Please try again." });
    }
  }

  // A shared link opens with its results.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once for the URL's query
  useEffect(() => {
    if (initialQuery.trim().length >= 2) void search(initialQuery);
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    void search(query);
  }

  async function makeClip(passage: LibraryPassage) {
    const key = `${passage.projectId}:${passage.startMs}`;
    setCreating(key);
    try {
      const response = await fetch(`/api/projects/${passage.projectId}/clips/create-from-range`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startSec: passage.startMs / 1000, endSec: passage.endMs / 1000 }),
      });
      if (!response.ok) {
        toaster.create({ type: "error", title: "Could not create the clip", description: await failureMessage(response) });
        return;
      }
      const clip = (await response.json()) as { id: string };
      router.push(`/projects/${passage.projectId}/clips/${clip.id}/studio`);
    } catch {
      toaster.create({ type: "error", title: "Could not create the clip", description: "Network error. Please try again." });
    } finally {
      setCreating(null);
    }
  }

  return (
    <Stack gap="8" maxW="880px" mx="auto">
      <Box animation="fade-up" animationFillMode="backwards">
        <PageHeader title="Search" description="Find moments across every transcript, by meaning or by exact words." />
      </Box>

      <Box as="form" role="search" onSubmit={submit} animation="fade-up" animationDelay="80ms" animationFillMode="backwards">
        <Flex gap="2">
          <Input
            aria-label="Search your library"
            placeholder="What did we say about pricing?"
            value={query}
            maxLength={300}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button type="submit" disabled={query.trim().length < 2 || state.status === "loading"} flexShrink={0}>
            <Search size={15} aria-hidden />
            Search
          </Button>
        </Flex>
      </Box>

      <Box aria-live="polite">
        {state.status === "idle" ? (
          <EmptyState
            icon={<Search size={20} strokeWidth={1.75} />}
            title="Search your library"
            description="Describe what you remember, or type words that were said. Results link to the exact moment."
          />
        ) : state.status === "loading" ? (
          <Flex justify="center" py="14">
            <Spinner size="md" />
          </Flex>
        ) : state.status === "error" ? (
          <EmptyState icon={<SearchX size={20} strokeWidth={1.75} />} title="Search is unavailable" description={state.message} />
        ) : state.results.length === 0 ? (
          <EmptyState
            icon={<SearchX size={20} strokeWidth={1.75} />}
            title="No matching moments"
            description="Only projects with a finished transcript can be searched. New transcripts appear within a minute or two."
          />
        ) : (
          <Stack as="ul" gap="2" listStyleType="none" m="0" p="0">
            {state.results.map((passage) => {
              const key = `${passage.projectId}:${passage.startMs}`;
              return (
                <Flex
                  as="li"
                  key={key}
                  gap="4"
                  align="flex-start"
                  p="4"
                  borderRadius="l3"
                  bg="bg.subtle"
                  transition="background 120ms ease"
                  _hover={{ bg: "bg.soft" }}
                >
                  <Stack gap="1.5" flex="1" minW="0">
                    <Flex align="baseline" gap="2" minW="0">
                      <Link href={`/projects/${passage.projectId}`}>
                        <Text fontSize="13px" fontWeight="500" color="fg" truncate _hover={{ textDecoration: "underline" }}>
                          {passage.projectTitle}
                        </Text>
                      </Link>
                      <Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums" flexShrink={0}>
                        {formatDuration(passage.startMs / 1000)} to {formatDuration(passage.endMs / 1000)}
                      </Text>
                    </Flex>
                    <Text fontSize="14px" color="fg.muted" lineClamp={4}>
                      {passage.text}
                    </Text>
                  </Stack>
                  {canCreate ? (
                    <Button size="sm" variant="subtle" flexShrink={0} disabled={creating !== null} onClick={() => void makeClip(passage)}>
                      {creating === key ? <Spinner size="xs" /> : <Scissors size={13} aria-hidden />}
                      Make a clip
                    </Button>
                  ) : null}
                </Flex>
              );
            })}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
