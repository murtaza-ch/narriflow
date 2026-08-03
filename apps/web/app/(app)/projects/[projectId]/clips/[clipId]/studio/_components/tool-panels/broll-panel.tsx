"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Text, Stack, Input, SimpleGrid } from "@chakra-ui/react";
import { Search, Film, Check, X, Link2, AlertTriangle, Play } from "lucide-react";
import { Spinner } from "@narriflow/ui";
import { brollQueryForClip, planBrollCutaways } from "@narriflow/validators";
import { formatDuration } from "@/lib/format";
import { useStudio } from "../studio-shell";

interface BrollResult {
  id: number;
  image: string;
  width: number;
  height: number;
  durationSec: number;
  downloadUrl: string;
  authorName?: string | null;
  authorUrl?: string | null;
  pageUrl?: string | null;
}

const INPUT_RESET = {
  border: "none",
  outline: "none",
  background: "transparent",
  boxShadow: "none",
  caretColor: "var(--chakra-colors-studio-accent)",
} as const;

export function BRollPanel() {
  const { clipInfo, aspectRatio, brollUrl, setBrollUrl } = useStudio();
  const orientation =
    aspectRatio === "16:9"
      ? "landscape"
      : aspectRatio === "1:1"
        ? "square"
        : "portrait";

  // Fix: this used to prefill with the raw clip title (a full sentence),
  // which made for a useless first search ("How to scale a SaaS startup in
  // 2026" as a literal Pexels query). Derive a short visual query instead —
  // the same query-builder the render pipeline itself falls back to.
  const derivedQuery = useMemo(
    () => brollQueryForClip(clipInfo.title, null),
    [clipInfo.title],
  );

  const [query, setQuery] = useState(derivedQuery ?? "");
  const [results, setResults] = useState<BrollResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  // Applied B-roll now lives in the editor document (undoable, autosaved) —
  // reading it from context instead of a locally-PATCHed clipInfo snapshot
  // is what keeps this in sync across undo/redo and panel remounts.
  const [selectedAttribution, setSelectedAttribution] = useState<{
    authorName: string;
    pageUrl: string | null;
  } | null>(null);
  const [customUrl, setCustomUrl] = useState(brollUrl ?? "");
  const [previewId, setPreviewId] = useState<number | null>(null);
  const didInit = useRef(false);

  // What the render pipeline will do automatically if the user applies no
  // manual pick: the same planner (planBrollCutaways) the worker uses,
  // computed here purely from the clip's own duration + derived query so the
  // preview never drifts from render-time behavior. Cues from the detection
  // LLM aren't available on ClipInfo yet — once they are, pass them here
  // instead of null and this preview upgrades for free.
  const plannedCutaways = useMemo(
    () => planBrollCutaways(clipInfo.duration, null, derivedQuery),
    [clipInfo.duration, derivedQuery],
  );

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/broll/search?query=${encodeURIComponent(q)}&orientation=${orientation}`,
        );
        const json = (await res.json()) as {
          configured?: boolean;
          results?: BrollResult[];
          error?: string;
        };
        if (!res.ok) throw new Error(json.error ?? "Search failed");
        setConfigured(json.configured !== false);
        setResults(json.results ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search failed");
      } finally {
        setLoading(false);
      }
    },
    [orientation],
  );

  // Auto-suggest from the derived query on first open.
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    if (query.trim()) void runSearch(query);
  }, [query, runSearch]);

  // Dispatches through the editor document reducer (undoable, autosaved in
  // the background) instead of PATCHing directly — the applied URL is
  // validated server-side (assertPublicHttpUrl) when the autosave PUT lands;
  // a rejection surfaces via the shell's general autosave error toast.
  const apply = useCallback(
    (result: BrollResult | null) => {
      setError(null);
      setBrollUrl(result?.downloadUrl ?? null);
      setSelectedAttribution(
        result?.authorName
          ? { authorName: result.authorName, pageUrl: result.pageUrl ?? null }
          : null,
      );
    },
    [setBrollUrl],
  );

  const applyCustomUrl = useCallback(() => {
    const trimmed = customUrl.trim();
    if (!trimmed) {
      apply(null);
      return;
    }
    setError(null);
    setBrollUrl(trimmed);
    setSelectedAttribution(null);
  }, [apply, customUrl, setBrollUrl]);

  return (
    <Stack gap="0" h="100%">
      {/* Search */}
      <Box p="12px" pb="8px">
        <Flex
          align="center"
          gap="8px"
          px="10px"
          h="34px"
          borderRadius="l2"
          bg="studio.subtle"
          borderWidth="1px"
          borderColor="studio.borderControl"
          _focusWithin={{ borderColor: "studio.ring" }}
          transition="border-color 120ms ease"
        >
          <Box color="studio.fgSubtle" flexShrink={0}>
            <Search size={13} />
          </Box>
          <Input
            aria-label="Search stock B-roll"
            placeholder="Search B-Roll (Pexels)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearch(query);
            }}
            size="xs"
            flex="1"
            fontSize="12px"
            color="studio.fg"
            css={INPUT_RESET}
            _placeholder={{ color: "studio.fgSubtle" }}
          />
          {loading ? <Spinner size="xs" /> : null}
        </Flex>
      </Box>

      <Box px="12px" pb="8px">
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
          Custom B-roll URL
        </Text>
        <Flex
          align="center"
          gap="8px"
          px="10px"
          h="34px"
          borderRadius="l2"
          bg="studio.subtle"
          borderWidth="1px"
          borderColor="studio.borderControl"
          _focusWithin={{ borderColor: "studio.ring" }}
          transition="border-color 120ms ease"
        >
          <Box color="studio.fgSubtle" flexShrink={0}>
            <Link2 size={13} />
          </Box>
          <Input
            aria-label="Custom B-roll URL"
            placeholder="https://example.com/cutaway.mp4"
            value={customUrl}
            onChange={(event) => setCustomUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyCustomUrl();
            }}
            size="xs"
            flex="1"
            fontSize="12px"
            color="studio.fg"
            css={INPUT_RESET}
            _placeholder={{ color: "studio.fgSubtle" }}
          />
          <Box
            as="button"
            aria-label="Apply custom B-roll URL"
            color="studio.fgMuted"
            cursor="pointer"
            _hover={{ color: "studio.fg" }}
            transition="color 120ms ease"
            onClick={applyCustomUrl}
          >
            <Check size={13} />
          </Box>
        </Flex>
      </Box>

      {/* Selected indicator — success stripe + label, never hue alone */}
      {brollUrl ? (
        <Flex
          mx="12px"
          mb="8px"
          pl="10px"
          pr="10px"
          py="8px"
          borderRadius="l2"
          bg="success.950"
          borderWidth="1px"
          borderColor="success.800"
          borderLeftWidth="3px"
          borderLeftColor="success.400"
          align="center"
          justify="space-between"
        >
          <Flex align="center" gap="6px" color="success.400" minW="0">
            <Check size={13} />
            <Stack gap="0" minW="0">
              <Text fontSize="11px" color="success.400" fontWeight="600">
                B-roll applied to this clip
              </Text>
              {selectedAttribution ? (
                <Text fontSize="10px" color="studio.fgMuted" truncate>
                  Video by {selectedAttribution.authorName} · Pexels
                </Text>
              ) : null}
            </Stack>
          </Flex>
          <Box
            as="button"
            aria-label="Remove B-roll"
            color="studio.fgMuted"
            cursor="pointer"
            _hover={{ color: "studio.fg" }}
            transition="color 120ms ease"
            flexShrink={0}
            onClick={() => apply(null)}
          >
            <X size={13} />
          </Box>
        </Flex>
      ) : plannedCutaways.length > 0 ? (
        <Box mx="12px" mb="8px" px="10px" py="8px" borderRadius="l2" bg="studio.subtle" borderWidth="1px" borderColor="studio.border">
          <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
            Planned automatic cutaways
          </Text>
          <Stack gap="4px">
            {plannedCutaways.map((cutaway, index) => (
              <Flex key={`${cutaway.startSec}-${index}`} align="center" justify="space-between" gap="8px">
                <Text fontSize="11px" color="studio.fgSubtle" flexShrink={0}>
                  Cutaway {index + 1}
                </Text>
                <Text
                  textStyle="data"
                  fontSize="11px"
                  color="studio.timecode"
                  flexShrink={0}
                >
                  {formatDuration(cutaway.startSec)}–{formatDuration(cutaway.endSec)}
                </Text>
                <Text fontSize="11px" color="studio.fgMuted" truncate flex="1" textAlign="right">
                  {cutaway.query}
                </Text>
              </Flex>
            ))}
          </Stack>
        </Box>
      ) : null}

      {error ? (
        <Flex role="alert" px="12px" pb="8px" align="center" gap="6px" color="danger.400">
          <AlertTriangle size={12} />
          <Text fontSize="11px" color="danger.400">
            {error}
          </Text>
        </Flex>
      ) : null}

      {/* Results */}
      <Box flex="1" overflowY="auto" px="12px" pb="12px">
        {!configured ? (
          <EmptyHint text="Stock B-roll search isn't available on your workspace yet." />
        ) : results.length === 0 && !loading ? (
          <EmptyHint text="No results. Try a different keyword." />
        ) : (
          <SimpleGrid columns={2} gap="8px">
            {results.map((result) => {
              const isSelected = brollUrl === result.downloadUrl;
              const isPreviewing = previewId === result.id;
              return (
                <Box
                  key={result.id}
                  position="relative"
                  borderRadius="l2"
                  overflow="hidden"
                  borderWidth="2px"
                  borderColor={isSelected ? "success.400" : "transparent"}
                  onMouseEnter={() => setPreviewId(result.id)}
                  onMouseLeave={() => setPreviewId((current) => (current === result.id ? null : current))}
                  _hover={{ borderColor: isSelected ? "success.400" : "studio.accent" }}
                  transition="border-color 120ms ease"
                >
                  <Box
                    as="button"
                    aria-label={`Use this B-roll clip (${result.durationSec}s)`}
                    aria-pressed={isSelected}
                    cursor="pointer"
                    display="block"
                    w="100%"
                    onClick={() => apply(result)}
                  >
                    {isPreviewing ? (
                      // eslint-disable-next-line jsx-a11y/media-has-caption
                      <video
                        src={result.downloadUrl}
                        poster={result.image}
                        autoPlay
                        muted
                        loop
                        playsInline
                        preload="none"
                        style={{
                          width: "100%",
                          height: "84px",
                          objectFit: "cover",
                          display: "block",
                          background: "black",
                        }}
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={result.image}
                        alt=""
                        style={{
                          width: "100%",
                          height: "84px",
                          objectFit: "cover",
                          display: "block",
                        }}
                      />
                    )}
                  </Box>

                  <Flex
                    position="absolute"
                    top="4px"
                    right="4px"
                    w="20px"
                    h="20px"
                    align="center"
                    justify="center"
                    borderRadius="l1"
                    bg="rgba(0,0,0,0.55)"
                    color="white"
                    cursor="pointer"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPreviewId((current) => (current === result.id ? null : result.id));
                    }}
                    aria-label={isPreviewing ? "Stop preview" : "Preview this clip"}
                    role="button"
                  >
                    <Play size={11} fill={isPreviewing ? "currentColor" : "none"} />
                  </Flex>

                  <Flex
                    position="absolute"
                    bottom="0"
                    left="0"
                    right="0"
                    px="6px"
                    py="3px"
                    justify="space-between"
                    align="center"
                    bg="rgba(0,0,0,0.6)"
                  >
                    <Stack gap="0" minW="0">
                      <Text textStyle="data" fontSize="10px" color="studio.fg">
                        {result.durationSec}s
                      </Text>
                      {result.authorName ? (
                        <Text fontSize="9px" color="studio.fgMuted" truncate maxW="90px">
                          {result.authorName}
                        </Text>
                      ) : null}
                    </Stack>
                    {isSelected ? (
                      <Box color="success.400" flexShrink={0}>
                        <Check size={11} />
                      </Box>
                    ) : null}
                  </Flex>
                </Box>
              );
            })}
          </SimpleGrid>
        )}
      </Box>
    </Stack>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      py="32px"
      px="16px"
      gap="10px"
      color="studio.fgSubtle"
    >
      {/* Ghost frame — the Blueline empty signature, graphite-tuned */}
      <Flex
        w="88px"
        aspectRatio={16 / 9}
        align="center"
        justify="center"
        borderWidth="1px"
        borderStyle="dashed"
        borderColor="studio.borderStrong"
        borderRadius="l1"
      >
        <Film size={18} strokeWidth={1.5} />
      </Flex>
      <Text fontSize="12px" color="studio.fgMuted" textAlign="center" lineHeight="1.5">
        {text}
      </Text>
    </Flex>
  );
}
