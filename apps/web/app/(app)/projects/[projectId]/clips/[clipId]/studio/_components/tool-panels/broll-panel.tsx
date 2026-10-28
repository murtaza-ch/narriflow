"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Flex, Text, Stack, Input, SimpleGrid } from "@chakra-ui/react";
import {
  PANEL_PX,
  PanelEmpty,
  PanelTabs,
  SectionLabel,
  SelectedCheck,
  softButtonProps,
  softFocusWithin,
} from "./panel-ui";
import { Search, Film, Check, ChevronRight, X, AlertTriangle, Play, Sparkles } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { brollQueryForClip, planBrollCutaways, userErrorMessage } from "@narriflow/validators";
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
        if (!res.ok) throw new Error(userErrorMessage(json.error) ?? "Search failed. Try again.");
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
      <Box px={PANEL_PX} pt="4" pb="3">
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

      {/* Selected indicator — accent tint + check + label, never hue alone */}
      {brollUrl ? (
        <Flex
          mx={PANEL_PX}
          mb="3"
          px="3.5"
          py="3"
          borderRadius="12px"
          bg="studio.accentSubtle"
          align="center"
          justify="space-between"
        >
          <Flex align="center" gap="10px" color="studio.accentFg" minW="0">
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
                <Text fontSize="11px" color="studio.fgMuted" truncate>
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
        <Box px={PANEL_PX} pb="3">
          <SectionLabel>Planned cutaways</SectionLabel>
          <Stack gap="1.5">
            {plannedCutaways.map((cutaway, index) => (
              <Flex
                key={`${cutaway.startSec}-${index}`}
                as="button"
                aria-label={`Preview automatic cutaway ${index + 1}, ${cutaway.query}, at ${formatDuration(cutaway.startSec)}`}
                title={cutaway.query}
                align="center"
                gap="3"
                w="100%"
                h="40px"
                pl="2"
                pr="3"
                borderRadius="10px"
                bg="studio.subtle"
                color="studio.fgSubtle"
                cursor="pointer"
                transition="background 120ms ease, color 120ms ease"
                _hover={{ bg: "studio.raised", color: "studio.fg" }}
                onClick={() => seekTo(cutaway.startSec)}
              >
                <Text
                  px="2"
                  py="1"
                  flexShrink={0}
                  borderRadius="6px"
                  bg="studio.canvas"
                  fontFamily="mono"
                  fontVariantNumeric="tabular-nums"
                  fontSize="11.5px"
                  color="studio.timecode"
                >
                  {formatDuration(cutaway.startSec)}–{formatDuration(cutaway.endSec)}
                </Text>
                <Text fontSize="13px" color="studio.fg" truncate flex="1" textAlign="left">
                  {cutaway.query}
                </Text>
                <ChevronRight size={14} />
              </Flex>
            ))}
          </Stack>
        </Box>
      ) : null}

      {error ? (
        <Flex role="alert" px={PANEL_PX} pb="3" align="center" gap="6px" color="danger.400">
          <AlertTriangle size={12} />
          <Text fontSize="12px" color="danger.400">
            {error}
          </Text>
        </Flex>
      ) : null}

      {/* Results */}
      <Box flex="1" overflowY="auto" px={PANEL_PX} pb="5">
        {!configured ? (
          <PanelEmpty
            icon={<Film size={18} />}
            title="Stock search is unavailable"
            actions={
              <Button size="xs" {...softButtonProps} onClick={() => setSourceMode("generate")}>
                <Sparkles size={12} /> Generate an image instead
              </Button>
            }
          >
            It&apos;s temporarily offline.
          </PanelEmpty>
        ) : results.length === 0 && !loading ? (
          <PanelEmpty icon={<Film size={18} />} title="No results">
            Try a different keyword.
          </PanelEmpty>
        ) : (
          <>
          <SectionLabel>Results</SectionLabel>
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
                  onMouseEnter={() => setPreviewId(result.id)}
                  onMouseLeave={() => setPreviewId((current) => (current === result.id ? null : current))}
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
                    top="2"
                    insetStart="2"
                    boxSize="22px"
                    align="center"
                    justify="center"
                    borderRadius="full"
                    bg="studio.scrim"
                    color="studio.fg"
                    cursor="pointer"
                    transition="background 120ms ease"
                    _hover={{ bg: "studio.scrimStrong" }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPreviewId((current) => (current === result.id ? null : result.id));
                    }}
                    aria-label={isPreviewing ? "Stop preview" : "Preview this clip"}
                    role="button"
                  >
                    <Play size={10} fill={isPreviewing ? "currentColor" : "none"} />
                  </Flex>
                  <SelectedCheck show={isSelected} />

                  <Flex
                    position="absolute"
                    bottom="0"
                    left="0"
                    right="0"
                    px="2"
                    py="1"
                    pointerEvents="none"
                    align="baseline"
                    gap="2"
                    bg={isSelected ? "studio.accentSubtle" : "studio.scrim"}
                    color={isSelected ? "studio.accentFg" : "studio.fg"}
                  >
                    <Text fontFamily="mono" fontVariantNumeric="tabular-nums" fontSize="11.5px">
                      {result.durationSec}s
                    </Text>
                    {result.authorName ? (
                      <Text fontSize="10px" color="studio.fgMuted" truncate>
                        {result.authorName}
                      </Text>
                    ) : null}
                  </Flex>
                </Box>
              );
            })}
          </SimpleGrid>
          </>
        )}
      </Box>
      </>
      )}
    </Stack>
  );
}
