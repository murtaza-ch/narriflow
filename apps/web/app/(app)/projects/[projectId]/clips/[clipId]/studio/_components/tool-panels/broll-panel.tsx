"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Text, Stack, Input, SimpleGrid } from "@chakra-ui/react";
import { Search, Film, Check, X, Link2, AlertTriangle, Play } from "lucide-react";
import { Spinner } from "@narriflow/ui";
import { brollQueryForClip, planBrollCutaways } from "@narriflow/validators";
import { formatDuration } from "@/lib/format";
import { useStudio } from "../studio-shell";
import {
  DEFAULT_BROLL_PREVIEW_DURATION_SEC,
	manualBrollPreviewWindowForEditedTimeMap,
} from "../broll-preview";
import { GeneratedMediaStudioPanel } from "./generated-media-studio-panel";
import {
  nextBrollInspectorModeForKey,
  type BrollInspectorMode,
} from "./generated-media-studio-model";

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

/**
 * Fix 14: a custom B-roll URL used to go straight into the document
 * unvalidated — a non-public URL (localhost, a private IP, etc.) would only
 * get caught server-side by `assertPublicHttpUrl` when the autosave PUT
 * landed, and that rejection previously surfaced as a bare 500 that wedged
 * autosave entirely (see route.ts's new UnsafeUrlError -> 422 mapping).
 * Catching it here, before dispatch, avoids the round-trip entirely for the
 * common case. This mirrors the STRUCTURAL half of the server's check
 * (packages/services/src/url-guard.ts's `assertPublicHttpUrl`) — scheme,
 * credentials, and literal private/reserved IPs/hostnames — since a DNS
 * lookup (catching a hostname that RESOLVES to a private address) can only
 * happen server-side. This is a UX pre-check, not a security boundary; the
 * server remains the source of truth.
 */
function validatePublicHttpUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter a valid URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "URL must start with http:// or https://.";
  }
  if (url.username || url.password) {
    return "URL can't include credentials.";
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return "That host isn't reachable — use a public URL.";
  }
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    const isPrivateIpv4 =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
    if (isPrivateIpv4) {
      return "That host isn't reachable — use a public URL.";
    }
  }
  if (hostname === "::1" || hostname === "::") {
    return "That host isn't reachable — use a public URL.";
  }
  return null;
}

export function BRollPanel() {
  const [mode, setMode] = useState<BrollInspectorMode>("browse");
  return (
    <Stack gap="0" h="100%">
      <Flex
        role="tablist"
        aria-label="B-roll media source"
        px="12px"
        pt="10px"
        gap="0"
        borderBottomWidth="1px"
        borderColor="studio.border"
      >
        {(["browse", "generate"] as const).map((candidate) => {
          const selected = mode === candidate;
          return (
            <Box
              key={candidate}
              as="button"
              id={`broll-${candidate}-tab`}
              role="tab"
              aria-selected={selected}
              aria-controls={`broll-${candidate}-panel`}
              tabIndex={selected ? 0 : -1}
              flex="1"
              py="8px"
              borderBottomWidth="2px"
              borderColor={selected ? "studio.accent" : "transparent"}
              color={selected ? "studio.fg" : "studio.fgMuted"}
              textStyle="eyebrow"
              cursor="pointer"
              onClick={() => setMode(candidate)}
              onKeyDown={(event) => {
                const next = nextBrollInspectorModeForKey(mode, event.key);
                if (!next) return;
                event.preventDefault();
                setMode(next);
                document.getElementById(`broll-${next}-tab`)?.focus();
              }}
            >
              {candidate === "browse" ? "Browse" : "Generate"}
            </Box>
          );
        })}
      </Flex>
      <Box
        id={`broll-${mode}-panel`}
        role="tabpanel"
        aria-labelledby={`broll-${mode}-tab`}
        flex="1"
        minH="0"
      >
        {mode === "browse" ? <BrollBrowser /> : <GeneratedMediaStudioPanel />}
      </Box>
    </Stack>
  );
}

function BrollBrowser() {
  const {
    clipInfo,
    aspectRatio,
    brollUrl,
    brollPreviewAsset,
		editedTimeMap,
    setBrollUrl,
    setBrollPreviewAsset,
    seekTo,
  } = useStudio();
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

  const [sourceMode, setSourceMode] = useState<"stock" | "url">("stock");
  const [query, setQuery] = useState(derivedQuery ?? "");
  const [results, setResults] = useState<BrollResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [customUrl, setCustomUrl] = useState(brollUrl ?? "");
  const [previewId, setPreviewId] = useState<number | null>(null);
  const didInit = useRef(false);

  const selectedAsset =
    brollPreviewAsset?.url === brollUrl ? brollPreviewAsset : null;
  const selectedWindow = useMemo(
    () =>
      brollUrl
			? manualBrollPreviewWindowForEditedTimeMap(
				editedTimeMap,
            selectedAsset?.durationSec,
          )
        : null,
		[brollUrl, editedTimeMap, selectedAsset?.durationSec],
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

  useEffect(() => {
    setCustomUrl(brollUrl ?? "");
  }, [brollUrl]);

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

  const applyCustomUrl = useCallback(() => {
    const trimmed = customUrl.trim();
    if (!trimmed) {
      apply(null);
      return;
    }
    const validationError = validatePublicHttpUrl(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setBrollUrl(trimmed);
    setBrollPreviewAsset({
      url: trimmed,
      durationSec: DEFAULT_BROLL_PREVIEW_DURATION_SEC,
      posterUrl: null,
      authorName: null,
      pageUrl: null,
    });
  }, [apply, customUrl, setBrollPreviewAsset, setBrollUrl]);

  return (
    <Stack gap="0" h="100%">
      <Flex gap="6px" p="12px" pb="8px">
        {([
          { id: "stock", label: "Stock library", icon: <Film size={12} /> },
          { id: "url", label: "Paste URL", icon: <Link2 size={12} /> },
        ] as const).map((source) => {
          const active = sourceMode === source.id;
          return (
            <Flex
              key={source.id}
              as="button"
              aria-pressed={active}
              align="center"
              justify="center"
              gap="5px"
              flex="1"
              h="30px"
              borderRadius="l2"
              bg={active ? "studio.raised" : "studio.subtle"}
              borderWidth="1px"
              borderColor={active ? "studio.accent" : "studio.border"}
              color={active ? "studio.accentFg" : "studio.fgMuted"}
              fontSize="11px"
              fontWeight="600"
              cursor="pointer"
              transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
              onClick={() => setSourceMode(source.id)}
            >
              {source.icon}
              {source.label}
            </Flex>
          );
        })}
      </Flex>

      {sourceMode === "stock" ? (
      <Box px="12px" pb="8px">
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
            placeholder="Search Pexels videos…"
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
          {loading ? (
            <Spinner size="xs" />
          ) : (
            <Text textStyle="eyebrow" fontSize="8px" color="studio.fgSubtle">
              Pexels
            </Text>
          )}
        </Flex>
      </Box>
      ) : (
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
        <Text mt="5px" fontSize="10px" color="studio.fgSubtle">
          Public MP4 links only. The URL is checked again when the clip saves.
        </Text>
      </Box>
      )}

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
                B-roll applied
              </Text>
              {selectedWindow ? (
                <Text textStyle="data" fontSize="10px" color="studio.timecode">
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
        <Box mx="12px" mb="8px" px="10px" py="8px" borderRadius="l2" bg="studio.subtle" borderWidth="1px" borderColor="studio.border">
          <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
            Planned automatic cutaways
          </Text>
          <Stack gap="4px">
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
      {sourceMode === "stock" ? (
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
      ) : (
        <Box flex="1" overflowY="auto" px="12px" pb="12px">
          <EmptyHint text="Paste a public video URL above, then press Enter or the checkmark to apply it." />
        </Box>
      )}
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
