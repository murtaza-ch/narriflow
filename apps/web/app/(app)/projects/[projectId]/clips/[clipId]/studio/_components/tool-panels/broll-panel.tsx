"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Text, Stack, Input, SimpleGrid } from "@chakra-ui/react";
import { PanelTabs, softFocusWithin } from "./panel-ui";
import { Search, Film, Check, X, AlertTriangle, Play, Sparkles } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { brollQueryForClip, planBrollCutaways } from "@narriflow/validators";
import { formatDuration } from "@/lib/format";
import { useStudio } from "../studio-shell";
import { manualBrollPreviewWindow } from "../broll-preview";
import { GeneratedImagesPanel } from "./generated-images-panel";

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
  const {
    clipInfo,
    aspectRatio,
    brollUrl,
    brollPreviewAsset,
    setBrollUrl,
    setBrollPreviewAsset,
    seekTo,
  } = useStudio("clipInfo", "aspectRatio", "brollUrl", "brollPreviewAsset", "setBrollUrl", "setBrollPreviewAsset", "seekTo");
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
    () =>
      clipInfo.brollCues[0]?.query.trim() ||
      brollQueryForClip(clipInfo.title, null),
    [clipInfo.brollCues, clipInfo.title],
  );

  const [sourceMode, setSourceMode] = useState<"stock" | "generate">("stock");
  const [query, setQuery] = useState(derivedQuery ?? "");
  const [results, setResults] = useState<BrollResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const didInit = useRef(false);

  const selectedAsset =
    brollPreviewAsset?.url === brollUrl ? brollPreviewAsset : null;
  const selectedWindow = useMemo(
    () =>
      brollUrl
        ? manualBrollPreviewWindow(
            clipInfo.duration,
            selectedAsset?.durationSec,
          )
        : null,
    [brollUrl, clipInfo.duration, selectedAsset?.durationSec],
  );

  // Use the exact detection cues consumed by the worker. Existing clips with
  // no cues retain the keyword fallback, but cue-rich clips no longer show
  // the same irrelevant query in every planned row.
  const plannedCutaways = useMemo(
    () => planBrollCutaways(clipInfo.duration, clipInfo.brollCues, derivedQuery),
    [clipInfo.brollCues, clipInfo.duration, derivedQuery],
  );

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        setError(null);
        setLoading(false);
        return;
      }
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
      setBrollPreviewAsset(
        result
          ? {
              url: result.downloadUrl,
              durationSec: result.durationSec,
              posterUrl: result.image,
              authorName: result.authorName ?? null,
              pageUrl: result.pageUrl ?? null,
            }
          : null,
      );
    },
    [setBrollPreviewAsset, setBrollUrl],
  );

  return (
    <Stack gap="0" h="100%">
      <PanelTabs
        ariaLabel="B-roll source"
        items={[
          { id: "stock", label: "Stock library", icon: <Film size={14} /> },
          { id: "generate", label: "Generate", icon: <Sparkles size={14} /> },
        ]}
        value={sourceMode}
        onChange={setSourceMode}
      />

      {sourceMode === "generate" ? (
        <GeneratedImagesPanel />
      ) : (
      <>
      <Box px="20px" pt="16px" pb="12px">
        <Flex
          align="center"
          gap="10px"
          px="12px"
          h="40px"
          borderRadius="10px"
          bg="studio.subtle"
          _focusWithin={softFocusWithin}
        >
          <Box color="studio.fgSubtle" flexShrink={0}>
            <Search size={13} />
          </Box>
          <Input
            aria-label="Search stock B-roll"
            placeholder="Search Pexels videos…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearch(query);
            }}
            size="sm"
            flex="1"
            fontSize="14px"
            color="studio.fg"
            css={INPUT_RESET}
            _placeholder={{ color: "studio.fgSubtle" }}
          />
          {loading ? (
            <Spinner size="xs" />
          ) : (
            <Text fontSize="11px" color="studio.fgSubtle">
              Pexels
            </Text>
          )}
        </Flex>
      </Box>

      {/* Selected indicator — success stripe + label, never hue alone */}
      {brollUrl ? (
        <Flex
          mx="20px"
          mb="12px"
          px="14px"
          py="12px"
          borderRadius="10px"
          bg="studio.subtle"
          align="center"
          justify="space-between"
        >
          <Flex align="center" gap="10px" color="studio.fg" minW="0">
            <Check size={15} />
            <Stack gap="0" minW="0">
              <Text fontSize="13px" color="studio.fg" fontWeight="500">
                B-roll applied
              </Text>
              {selectedWindow ? (
                <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.timecode">
                  {formatDuration(selectedWindow.startSec)}–{formatDuration(selectedWindow.endSec)} · {(selectedWindow.endSec - selectedWindow.startSec).toFixed(1)}s
                </Text>
              ) : null}
              {selectedAsset?.authorName ? (
                <Text fontSize="10px" color="studio.fgMuted" truncate>
                  Video by {selectedAsset.authorName} · Pexels
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
        <Box mx="20px" mb="12px" px="14px" py="12px" borderRadius="10px" bg="studio.subtle">
          <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="8px">
            Planned automatic cutaways
          </Text>
          <Stack gap="6px">
            {plannedCutaways.map((cutaway, index) => (
              <Flex
                key={`${cutaway.startSec}-${index}`}
                as="button"
                aria-label={`Preview automatic cutaway ${index + 1}, ${cutaway.query}, at ${formatDuration(cutaway.startSec)}`}
                title={cutaway.query}
                align="center"
                justify="space-between"
                gap="8px"
                w="100%"
                cursor="pointer"
                borderRadius="l1"
                _hover={{ bg: "studio.raised" }}
                onClick={() => seekTo(cutaway.startSec)}
              >
                <Text fontSize="12px" color="studio.fgSubtle" flexShrink={0}>
                  Cutaway {index + 1}
                </Text>
                <Text
                  fontVariantNumeric="tabular-nums"
                  fontSize="12px"
                  color="studio.timecode"
                  flexShrink={0}
                >
                  {formatDuration(cutaway.startSec)}–{formatDuration(cutaway.endSec)}
                </Text>
                <Text fontSize="12px" color="studio.fgMuted" truncate flex="1" textAlign="right">
                  {cutaway.query}
                </Text>
              </Flex>
            ))}
          </Stack>
        </Box>
      ) : null}

      {error ? (
        <Flex role="alert" px="20px" pb="12px" align="center" gap="6px" color="danger.400">
          <AlertTriangle size={12} />
          <Text fontSize="11px" color="danger.400">
            {error}
          </Text>
        </Flex>
      ) : null}

      {/* Results */}
      <Box flex="1" overflowY="auto" px="20px" pb="20px">
        {!configured ? (
          <EmptyHint text="Stock B-roll search is temporarily unavailable.">
            <Flex as="button" minH="24px" align="center" gap="6px" color="studio.fg" fontSize="13px" fontWeight="500" cursor="pointer" onClick={() => setSourceMode("generate")}>
              <Sparkles size={12} /> Generate an image instead
            </Flex>
          </EmptyHint>
        ) : results.length === 0 && !loading ? (
          <EmptyHint text="No results. Try a different keyword." />
        ) : (
          <SimpleGrid columns={2} gap="10px">
            {results.map((result) => {
              const isSelected = brollUrl === result.downloadUrl;
              const isPreviewing = previewId === result.id;
              return (
                <Box
                  key={result.id}
                  position="relative"
                  borderRadius="10px"
                  overflow="hidden"
                  borderWidth="2px"
                  borderColor={isSelected ? "studio.accent" : "transparent"}
                  onMouseEnter={() => setPreviewId(result.id)}
                  onMouseLeave={() => setPreviewId((current) => (current === result.id ? null : current))}
                  _hover={{ borderColor: isSelected ? "studio.accent" : "studio.borderStrong" }}
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
                          height: "96px",
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
                          height: "96px",
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
                      <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fg">
                        {result.durationSec}s
                      </Text>
                      {result.authorName ? (
                        <Text fontSize="9px" color="studio.fgMuted" truncate maxW="90px">
                          {result.authorName}
                        </Text>
                      ) : null}
                    </Stack>
                    {isSelected ? (
                      <Box color="studio.fg" flexShrink={0}>
                        <Check size={12} />
                      </Box>
                    ) : null}
                  </Flex>
                </Box>
              );
            })}
          </SimpleGrid>
        )}
      </Box>
      </>
      )}
    </Stack>
  );
}

function EmptyHint({ text, children }: { text: string; children?: React.ReactNode }) {
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
        bg="studio.subtle"
        borderRadius="10px"
      >
        <Film size={18} strokeWidth={1.5} />
      </Flex>
      <Text fontSize="13px" color="studio.fgMuted" textAlign="center" lineHeight="1.5">
        {text}
      </Text>
      {children}
    </Flex>
  );
}
