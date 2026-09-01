"use client";

import type { SyntheticEvent } from "react";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { EditClipLengthDialog } from "./edit-clip-length-dialog";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import {
  clipAspectRatioOptions,
  userErrorMessage,
  type ClipAspectRatio,
  type ClipSnapshot,
} from "@narriflow/validators";
import { Box, Flex, HStack, Portal, Stack, Text, Tooltip } from "@chakra-ui/react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Pencil,
  Scissors,
} from "lucide-react";
import { formatDuration, formatTimecode } from "@/lib/format";
import {
  clipFileDownloadPath,
  clipMediaPayloadForClip,
  clipMediaDescriptorFromPayload,
  loadClipPreview,
} from "@/lib/clip-media";
import { ClipActionsMenu } from "./clip-actions-menu";

const platformLabels = [
  { key: "tiktokScore" as const, label: "TikTok" },
  { key: "youtubeScore" as const, label: "YouTube" },
  { key: "instagramScore" as const, label: "Instagram" },
];

const platformFitLabels: Record<string, string> = {
  tiktok: "TikTok",
  youtube_shorts: "Shorts",
  instagram_reels: "Reels",
};

function getInitialAspectRatio(clip: ClipSnapshot): ClipAspectRatio {
  const preferred = clip.renderVariants.find(
    (render) => render.aspectRatio === "9:16" && render.hasAsset,
  );
  if (preferred) return preferred.aspectRatio;
  const firstAvailable = clip.renderVariants.find((render) => render.hasAsset);
  return firstAvailable?.aspectRatio ?? "9:16";
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function apiErrorCopy(payload: unknown, fallback: string): string {
  const errorCode = readPayloadString(payload, "error");
  return (
    userErrorMessage(errorCode) ??
    readPayloadString(payload, "message") ??
    fallback
  );
}

function isRenderQueueResponse(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  return (
    typeof value.workflowRunId === "string" &&
    value.workflowRunId.length > 0 &&
    typeof value.acceptedAt === "string" &&
    !Number.isNaN(Date.parse(value.acceptedAt)) &&
    typeof value.initialSeq === "number" &&
    Number.isInteger(value.initialSeq) &&
    value.initialSeq >= 0
  );
}

function SubScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <Flex align="center" gap="2" fontSize="11px">
      <Text color="fg.muted" w="60px" flexShrink={0}>
        {label}
      </Text>
      <Box flex="1" h="3px" bg="bg.muted" borderRadius="full" overflow="hidden">
        <Box
          h="full"
          borderRadius="full"
          bg={value >= 70 ? "success.solid" : value >= 40 ? "warning.solid" : "fg.subtle"}
          w={`${value}%`}
          animation="meter-fill"
        />
      </Box>
      <Text textStyle="data" color="fg.subtle" w="24px" textAlign="right">
        {value}
      </Text>
    </Flex>
  );
}

/**
 * Preview player for one clip segment.
 *
 * Only rows at or near the viewport are allowed to touch the network. A
 * project renders every clip at once (10 by default), and each preview is a
 * cross-origin R2 object, so `preload="metadata"` on all of them put ten
 * simultaneous range requests in flight on mount — they contend, none of them
 * paints a first frame, and the wells sit empty exactly as long as the slowest
 * one takes. Loading two or three at a time instead means the visible clips
 * paint promptly and offscreen ones cost nothing until scrolled to.
 *
 * The `#t=` media fragment is what actually puts a frame on screen: the
 * browser seeks to the clip's in-point while loading metadata, natively,
 * instead of waiting for `loadedmetadata` to round-trip through React. The
 * handlers below stay as the fallback for browsers that ignore the fragment,
 * and to loop back to the in-point at the end.
 */
function ClipVideo({
  src,
  startSec,
  endSec,
}: {
  src: string;
  startSec: number;
  endSec: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    // No IntersectionObserver (or SSR-hydrated older browser) — fall back to
    // the previous always-load behaviour rather than showing nothing.
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      // Start a row early so scrolling lands on a painted frame, not a gap.
      { rootMargin: "300px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <Box ref={containerRef} w="full" h="full">
      {/* biome-ignore lint/a11y/useMediaCaption: preview player for a clip segment; no caption/VTT source is available in this component. */}
      <video
        src={`${src}#t=${startSec},${endSec}`}
        controls
        preload={shouldLoad ? "metadata" : "none"}
        style={{ width: "100%", height: "100%", display: "block", objectFit: "contain" }}
        onLoadedMetadata={(event: SyntheticEvent<HTMLVideoElement>) => {
          const video = event.currentTarget;
          if (video.currentTime < startSec) video.currentTime = startSec;
        }}
        onTimeUpdate={(event: SyntheticEvent<HTMLVideoElement>) => {
          const video = event.currentTarget;
          if (video.currentTime >= endSec) {
            video.pause();
            video.currentTime = startSec;
          }
        }}
      />
    </Box>
  );
}

function WellPlaceholder({
  loading,
  aspectCss,
  caption,
}: {
  loading?: boolean;
  aspectCss: string;
  caption: string;
}) {
  return (
    <Flex w="full" h="full" direction="column" align="center" justify="center" gap="2" px="2">
      <Box
        position="relative"
        w="40px"
        borderWidth="1px"
        borderStyle="dashed"
        borderColor="studio.borderControl"
        borderRadius="l1"
        overflow="hidden"
        css={{ aspectRatio: aspectCss }}
        aria-hidden="true"
      >
        <Box position="absolute" inset="0" color="studio.border">
          <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <line x1="0" y1="0" x2="100" y2="100" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <line x1="100" y1="0" x2="0" y2="100" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
        </Box>
        {loading && (
          <Flex position="absolute" inset="0" align="center" justify="center">
            <Spinner size="xs" />
          </Flex>
        )}
      </Box>
      <Text textStyle="data" fontSize="10px" color="studio.fgSubtle" textAlign="center">
        {caption}
      </Text>
    </Flex>
  );
}

/**
 * Disabled-but-hoverable trigger for the Publish tooltip. A native
 * `disabled` button suppresses pointer events in most browsers, which would
 * kill hover — this renders the visual disabled state without the attribute
 * so the tooltip still opens on hover/focus.
 */
function DisabledPublishButton() {
  return (
    <Flex
      as="span"
      tabIndex={0}
      align="center"
      justify="center"
      h="8"
      px="3"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l2"
      color="fg.disabled"
      fontSize="13px"
      fontWeight="500"
      cursor="not-allowed"
      flex="1"
      minW="0"
    >
      <Text truncate>Publish</Text>
    </Flex>
  );
}

export interface ClipRowProps {
  clip: ClipSnapshot;
  projectId: string;
  /** Immutable virality rank (1-based), or null for the caption-only
   *  pseudo-clip row (no rank/score/why-this-clip framing). */
  rank: number | null;
  compact: boolean;
  selected: boolean;
  onToggleSelect: (clipId: string, selected: boolean) => void;
  /** Presigned source video for the Trim/Extend preview pane; null once the
   *  source is purged (the dialog degrades to transcript-only). */
  sourceVideoUrl: string | null;
}

export function ClipRow({ clip, projectId, rank, compact, selected, onToggleSelect, sourceVideoUrl }: ClipRowProps) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [, startTransition] = useTransition();
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [scoresExpanded, setScoresExpanded] = useState(false);
  const [editingBoundaries, setEditingBoundaries] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedAspectRatio, setSelectedAspectRatio] = useState<ClipAspectRatio>(() =>
    getInitialAspectRatio(clip),
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewIsProxy, setPreviewIsProxy] = useState(false);
  const [previewOffsetSec, setPreviewOffsetSec] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [queuedAspectRatios, setQueuedAspectRatios] = useState<ClipAspectRatio[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the clip identity or render variants change.
  useEffect(() => {
    setSelectedAspectRatio(getInitialAspectRatio(clip));
    setQueuedAspectRatios([]);
  }, [clip.id, clip.renderVariants]);

  const renderVariantMap = new Map(clip.renderVariants.map((render) => [render.aspectRatio, render]));
  const selectedVariant = renderVariantMap.get(selectedAspectRatio) ?? null;
  const selectedOption =
    clipAspectRatioOptions.find((option) => option.value === selectedAspectRatio) ??
    clipAspectRatioOptions[0]!;
  const selectedStatus = queuedAspectRatios.includes(selectedAspectRatio)
    ? "rendering"
    : selectedVariant?.status ?? "missing";
  const selectedVariantHasAsset =
    Boolean(selectedVariant?.hasAsset) && !queuedAspectRatios.includes(selectedAspectRatio);
  const hasAnyRenderedAsset = clip.renderVariants.some((render) => render.hasAsset);

  // Same "always show something playable" preview-fetch effect as the
  // original ClipCard — see there for the full rationale on hasPreview
  // being in the deps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: asset readiness fields intentionally retrigger the preview fetch.
  useEffect(() => {
    let cancelled = false;

    const loadPreview = async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      setPreviewPending(false);
      try {
        const result = await loadClipPreview(
          `/api/projects/${clip.projectId}/clips/previews?aspectRatio=${encodeURIComponent(selectedAspectRatio)}`,
        );

        if (!result.ok) {
          const message = readPayloadString(result.payload, "message");
          if (
            message === "clip render not found" ||
            message === "clip has not been rendered for this aspect ratio"
          ) {
            if (!cancelled) {
              setPreviewUrl(null);
              setPreviewPending(true);
            }
            return;
          }
          console.error("clip_preview_load_failed", result.status);
          if (!cancelled) {
            setPreviewUrl(null);
            setPreviewError(
              apiErrorCopy(result.payload, "Could not load this preview."),
            );
          }
          return;
        }

        const payload = clipMediaPayloadForClip(result.payload, clip.id);
        if (!payload) {
          if (!cancelled) {
            setPreviewUrl(null);
            setPreviewPending(true);
          }
          return;
        }

        const descriptor = clipMediaDescriptorFromPayload(payload);
        if (!descriptor) {
          console.error("clip_preview_load_failed_invalid_response");
          if (!cancelled) {
            setPreviewUrl(null);
            setPreviewError("Could not load this preview.");
          }
          return;
        }

        if (!cancelled) {
          setPreviewUrl(descriptor.downloadUrl);
          setPreviewIsProxy(descriptor.isPreviewProxy);
          setPreviewOffsetSec(descriptor.previewStartSec);
        }
      } catch {
        console.error("clip_preview_load_failed");
        if (!cancelled) {
          setPreviewUrl(null);
          setPreviewError("Could not load this preview.");
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    };

    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [
    clip.id,
    clip.projectId,
    clip.hasPreview,
    selectedAspectRatio,
    selectedVariantHasAsset,
    selectedVariant?.status,
    selectedVariant?.completedAt,
  ]);

  async function queueRender(aspectRatio: ClipAspectRatio) {
    setSelectedAspectRatio(aspectRatio);
    setQueuedAspectRatios((current) => (current.includes(aspectRatio) ? current : [...current, aspectRatio]));
    setActionError(null);
    let accepted = false;

    try {
      const response = await fetch(`/api/projects/${clip.projectId}/clips/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ clipIds: [clip.id], aspectRatios: [aspectRatio] }),
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        console.error("clip_render_queue_failed", response.status);
        setActionError(apiErrorCopy(payload, "Could not queue this render."));
        return;
      }
      if (!isRenderQueueResponse(payload)) {
        console.error("clip_render_queue_invalid_response");
        setActionError("The render may have queued, but the response was incomplete.");
        return;
      }

      accepted = true;
      startTransition(() => router.refresh());
    } catch {
      console.error("clip_render_queue_failed");
      setActionError("Could not queue this render.");
    } finally {
      if (!accepted) {
        setQueuedAspectRatios((current) => current.filter((value) => value !== aspectRatio));
      }
    }
  }

  async function handleRenderWithConfirm(aspectRatio: ClipAspectRatio) {
    const isRetry = renderVariantMap.get(aspectRatio)?.status === "failed";
    const confirmed = await confirm({
      title: isRetry ? `Retry the ${aspectRatio} render?` : `Queue a ${aspectRatio} render?`,
      description: "Rendering burns captions into a new video file and uses render capacity on your plan.",
      confirmLabel: isRetry ? "Retry render" : "Queue render",
    });
    if (!confirmed) return;
    await queueRender(aspectRatio);
  }

  const studioHref = `/projects/${clip.projectId}/clips/${clip.id}/studio`;
  const publishHref = `/projects/${projectId}?tab=publish`;
  const visibleError = actionError ?? previewError;
  const isCaptionOnly = rank === null;
  // The preview is the thing being judged, so it takes the room the wider
  // container frees up — but only in comfortable mode. A 9:16 preview is the
  // tallest element in the row at any width, so it sets row height outright:
  // measured, every extra 8px of preview width costs ~14px of row height, and
  // widening compact previews to 148px took rows from 269px to 340px. That is
  // precisely the density the compact toggle exists to protect, so compact
  // stays fixed and comfortable absorbs the new width.
  const mediaW = compact ? "108px" : { base: "168px", lg: "200px", "2xl": "232px" };

  // Readable measure for the prose blocks. Unconstrained, "Why this clip" ran
  // the full 1000px content width — ~120 characters per line, well past the
  // 45–75 the eye tracks comfortably.
  const measure = "68ch";

  return (
    <Box
      position="relative"
      borderBottomWidth="1px"
      borderColor="border.subtle"
      py={compact ? "3" : "4"}
      ps="4"
      pe="1"
      transition="background 120ms ease"
      bg={selected ? "accent.subtle" : undefined}
      _before={{
        content: '""',
        position: "absolute",
        insetBlock: "0",
        insetInlineStart: "0",
        w: "3px",
        bg: selected ? "accent.solid" : "transparent",
        transition: "background 120ms ease",
      }}
      _hover={{ bg: selected ? "accent.subtle" : "bg.subtle" }}
    >
      <Flex gap="3" align="flex-start">
        {!isCaptionOnly && (
          <Box pt="1" flexShrink={0}>
            <Checkbox
              checked={selected}
              onCheckedChange={(checked) => onToggleSelect(clip.id, checked)}
              aria-label={`Select clip ${rank}`}
            />
          </Box>
        )}

        {/* Left — media well */}
        <Box flexShrink={0} w={mediaW}>
          <MediaWell
            ratio={selectedOption.width / selectedOption.height}
            timecode={formatDuration(clip.durationSec)}
          >
            {previewUrl ? (
              <ClipVideo
                src={previewUrl}
                startSec={previewIsProxy ? Math.max(0, clip.startSec - previewOffsetSec) : 0}
                endSec={
                  previewIsProxy
                    ? Math.max(0, clip.endSec - previewOffsetSec)
                    : clip.durationSec
                }
              />
            ) : (
              <WellPlaceholder
                loading={previewLoading}
                aspectCss={selectedOption.css}
                caption={
                  previewLoading
                    ? "Loading…"
                    : previewPending
                      ? selectedStatus === "failed"
                        ? "Render failed"
                        : "Preparing preview…"
                      : "Unavailable"
                }
              />
            )}
          </MediaWell>

          {/* Format pills */}
          <Flex gap="1" wrap="wrap" mt="1.5" role="radiogroup" aria-label="Preview format">
            {clipAspectRatioOptions.map((option) => {
              const variant = renderVariantMap.get(option.value);
              const isSelected = option.value === selectedAspectRatio;
              const isQueued = queuedAspectRatios.includes(option.value);
              const status = isQueued ? "rendering" : variant?.status ?? "missing";
              const isAvailable = Boolean(variant?.hasAsset) && !isQueued;
              const isInFlight = status === "pending" || status === "rendering";

              return (
                <Box
                  key={option.value}
                  as="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={`${option.value}`}
                  px="1.5"
                  py="0.5"
                  borderRadius="l1"
                  borderWidth="1px"
                  borderStyle={isAvailable || isSelected ? "solid" : "dashed"}
                  borderColor={isSelected ? "accent.solid" : isAvailable ? "border.emphasized" : "border"}
                  cursor="pointer"
                  transition="border-color 120ms ease"
                  onClick={() => setSelectedAspectRatio(option.value)}
                >
                  <Flex align="center" gap="1">
                    <Text textStyle="data" fontSize="10px" color={isAvailable || isSelected ? "fg" : "fg.subtle"}>
                      {option.value}
                    </Text>
                    {isAvailable && (
                      <Box asChild color="success.fg" aria-hidden="true">
                        <Check size={9} strokeWidth={3} />
                      </Box>
                    )}
                    {isInFlight && <Spinner size="xs" />}
                    {status === "failed" && !isAvailable && !isInFlight && (
                      <Box asChild color="danger.fg" aria-hidden="true">
                        <AlertTriangle size={9} />
                      </Box>
                    )}
                  </Flex>
                </Box>
              );
            })}
          </Flex>
        </Box>

        {/* Right — content */}
        <Stack flex="1" minW="0" gap="2">
          {/* Capped to the prose measure plus a meta allowance so the score
              sits with the title it grades. Left unbounded, space-between
              threw it to the container's right edge, ~560px clear of the text.
              Only the header is capped — capping the whole column wrapped the
              action row and pushed rows from 269px to 472px. */}
          <Flex
            align="flex-start"
            justify="space-between"
            gap="3"
            wrap="wrap"
            maxW={`calc(${measure} + 200px)`}
          >
            <Box minW="0" flex="1">
              <Flex align="center" gap="2" mb="0.5">
                {!isCaptionOnly && (
                  <Text textStyle="eyebrow" color="accent.fg">
                    #{rank}
                  </Text>
                )}
                <Text textStyle="eyebrow" color={clip.category === "hook" ? "accent.fg" : "fg.subtle"}>
                  {clip.category}
                </Text>
              </Flex>
              <Link href={studioHref}>
                <Text
                  fontSize="sm"
                  fontWeight="500"
                  color="fg"
                  lineHeight="1.4"
                  lineClamp={compact ? 1 : 2}
                  textDecoration="underline"
                  textDecorationColor="transparent"
                  textUnderlineOffset="3px"
                  transition="text-decoration-color 120ms ease"
                  _hover={{ textDecorationColor: "border.emphasized" }}
                >
                  {isCaptionOnly ? "Captioned video" : clip.title ?? clip.hookText}
                </Text>
              </Link>
              <Text mt="0.5" textStyle="data" fontSize="11px" color="fg.timecode">
                {formatTimecode(clip.startSec)} – {formatTimecode(clip.endSec)}
              </Text>
              {/* No out-of-preferred-range warning here: detection now sizes
                  each clip to its story arc on purpose (durations outside
                  30-60s are already priced into the virality score via
                  durationOptimality), so a warning would flag healthy clips.
                  The 30-60s duration FILTER in clips-panel.tsx remains. */}
            </Box>

            <Flex align="flex-start" gap="1" flexShrink={0}>
              {!isCaptionOnly && (
                <Stack gap="0.5" align="flex-end">
                  <Text
                    textStyle="data"
                    fontWeight="600"
                    fontSize="26px"
                    lineHeight="1"
                    color={
                      clip.viralityScore >= 70
                        ? "success.fg"
                        : clip.viralityScore >= 40
                          ? "warning.fg"
                          : "fg.muted"
                    }
                  >
                    {clip.viralityScore}
                  </Text>
                  <Button
                    variant="ghost"
                    size="2xs"
                    onClick={() => setScoresExpanded((v) => !v)}
                    aria-expanded={scoresExpanded}
                  >
                    {scoresExpanded ? "Hide scores" : "Scores"}
                    {scoresExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  </Button>
                </Stack>
              )}

              {/* Overflow actions — rename (manual + AI), duplicate, delete.
                  Offered on the caption-only row too: it is a real clip with a
                  real title and a real rendered file, so it renames, duplicates
                  and deletes exactly like any other. */}
              <ClipActionsMenu
                projectId={clip.projectId}
                clipId={clip.id}
                title={clip.title}
                fallbackTitle={isCaptionOnly ? "Captioned video" : clip.hookText}
              />
            </Flex>
          </Flex>

          {scoresExpanded && !isCaptionOnly && (
            <Stack gap="1" pt="1">
              <SubScoreBar label="Hook" value={clip.hookStrengthScore} />
              <SubScoreBar label="Emotion" value={clip.emotionalIntensityScore} />
              <SubScoreBar label="Story" value={clip.storyCompletenessScore} />
              <SubScoreBar label="Pacing" value={clip.pacingScore} />
              <SubScoreBar label="Duration" value={clip.durationOptimalityScore} />
              <HStack gap="3" wrap="wrap" pt="1">
                {platformLabels.map(({ key, label }) => (
                  <HStack key={key} gap="1">
                    <Text fontSize="11px" color="fg.muted">
                      {label}
                    </Text>
                    <Text
                      textStyle="data"
                      fontSize="11px"
                      fontWeight="600"
                      color={clip[key] >= 70 ? "success.fg" : clip[key] >= 40 ? "warning.fg" : "fg.muted"}
                    >
                      {clip[key]}
                    </Text>
                  </HStack>
                ))}
                {clip.platformFit.map((platform) => (
                  <Text key={platform} textStyle="eyebrow" color="fg.subtle">
                    {platformFitLabels[platform] ?? platform}
                  </Text>
                ))}
              </HStack>
            </Stack>
          )}

          {!isCaptionOnly && (
            <Box>
              <Text textStyle="eyebrow" color="fg.subtle" mb="0.5">
                Why this clip
              </Text>
              <Text
                fontSize="xs"
                color="fg"
                lineHeight="1.6"
                maxW={measure}
                lineClamp={reasoningExpanded ? undefined : 2}
              >
                {clip.reasoning}
                {clip.payoffText ? ` Payoff: ${clip.payoffText}` : ""}
              </Text>
              {(clip.reasoning.length > 140 || (clip.payoffText?.length ?? 0) > 0) && (
                <Button
                  variant="ghost"
                  size="2xs"
                  mt="0.5"
                  onClick={() => setReasoningExpanded((v) => !v)}
                >
                  {reasoningExpanded ? "Show less" : "Show more"}
                </Button>
              )}
            </Box>
          )}

          {clip.transcriptSlice.length > 0 && (
            <Box>
              <Flex align="center" justify="space-between" mb="0.5">
                <Text textStyle="eyebrow" color="fg.subtle">
                  Transcript
                </Text>
                <Button
                  variant="ghost"
                  size="2xs"
                  onClick={() => setTranscriptExpanded((v) => !v)}
                  aria-expanded={transcriptExpanded}
                >
                  {transcriptExpanded ? "Collapse" : "Expand"}
                  {transcriptExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                </Button>
              </Flex>
              {transcriptExpanded ? (
                <Stack maxH="9rem" gap="0" overflowY="auto" borderTopWidth="1px" borderColor="border.subtle">
                  {clip.transcriptSlice.map((utterance, index) => (
                    <Box
                      key={`${utterance.index}-${utterance.startSec}`}
                      py="1.5"
                      borderTopWidth={index > 0 ? "1px" : "0"}
                      borderColor="border.subtle"
                    >
                      <Flex gap="1.5" align="center" mb="0.5">
                        <Text fontSize="11px" fontWeight="500" color="fg">
                          {utterance.speakerLabel}
                        </Text>
                        <Text textStyle="data" fontSize="10px" color="fg.timecode">
                          {formatTimecode(utterance.startSec)}
                        </Text>
                      </Flex>
                      <Text fontSize="xs" lineHeight="1.5" color="fg" maxW={measure}>
                        {utterance.text}
                      </Text>
                    </Box>
                  ))}
                </Stack>
              ) : (
                <Flex gap="1.5" align="baseline" maxW={measure}>
                  <Text textStyle="data" fontSize="10px" color="fg.timecode" flexShrink={0}>
                    {formatTimecode(clip.transcriptSlice[0]!.startSec)}
                  </Text>
                  <Text fontSize="xs" color="fg.muted" lineClamp={1}>
                    {clip.transcriptSlice[0]!.text}
                  </Text>
                </Flex>
              )}
            </Box>
          )}

          {(selectedStatus === "pending" || selectedStatus === "rendering") && (
            <Flex align="center" gap="2">
              <Spinner size="xs" />
              <Text fontSize="11px" color="fg.muted">
                {selectedStatus === "pending"
                  ? `${selectedAspectRatio} render is queued`
                  : `${selectedAspectRatio} render is processing`}
              </Text>
            </Flex>
          )}
          {selectedStatus === "failed" && selectedVariant?.errorCode ? (
            <Flex align="center" gap="1.5" color="danger.fg">
              <AlertTriangle size={12} aria-hidden />
              <Text fontSize="11px">Render failed: {userErrorMessage(selectedVariant.errorCode)}</Text>
            </Flex>
          ) : null}

          {/* Action row — all outline/ghost, never solid (the view's one
              solid button lives in the toolbar as "Render selected"). */}
          <Flex gap="1.5" align="center" wrap="wrap" pt="1">
            {hasAnyRenderedAsset ? (
              <Tooltip.Root openDelay={100} closeDelay={0}>
                <Tooltip.Trigger asChild>
                  <Button size="xs" variant="outline" asChild flexShrink={0}>
                    <Link href={publishHref}>Publish</Link>
                  </Button>
                </Tooltip.Trigger>
                <Portal>
                  <Tooltip.Positioner>
                    <Tooltip.Content bg="bg.panel" color="fg" borderWidth="1px" borderColor="border" borderRadius="l1" px="2" py="1" fontSize="11px">
                      Go to Publish
                    </Tooltip.Content>
                  </Tooltip.Positioner>
                </Portal>
              </Tooltip.Root>
            ) : (
              <Tooltip.Root openDelay={100} closeDelay={0}>
                <Tooltip.Trigger asChild>
                  <Box>
                    <DisabledPublishButton />
                  </Box>
                </Tooltip.Trigger>
                <Portal>
                  <Tooltip.Positioner>
                    <Tooltip.Content bg="bg.panel" color="fg" borderWidth="1px" borderColor="border" borderRadius="l1" px="2" py="1" fontSize="11px">
                      Render a variant before publishing
                    </Tooltip.Content>
                  </Tooltip.Positioner>
                </Portal>
              </Tooltip.Root>
            )}

            {selectedVariantHasAsset ? (
              <Button size="xs" variant="outline" asChild>
                <a
                  href={clipFileDownloadPath(
                    clip.projectId,
                    clip.id,
                    selectedAspectRatio,
                  )}
                  download
                >
                  <Download size={12} />
                  <Text ms="1">Download</Text>
                </a>
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={selectedStatus === "pending" || selectedStatus === "rendering"}
                onClick={() => handleRenderWithConfirm(selectedAspectRatio)}
              >
                {selectedStatus === "pending" || selectedStatus === "rendering" ? (
                  <Spinner size="xs" />
                ) : (
                  <Check size={12} />
                )}
                <Text ms="1">{selectedStatus === "failed" ? "Retry render" : "Render"}</Text>
              </Button>
            )}

            <Button size="xs" variant="ghost" asChild>
              <Link href={studioHref}>
                <Pencil size={12} />
                <Text ms="1">Studio</Text>
              </Link>
            </Button>

            <Button
              size="xs"
              variant="ghost"
              ms="auto"
              onClick={() => setEditingBoundaries(true)}
            >
              <Scissors size={12} />
              <Text ms="1">Trim / Extend</Text>
            </Button>
          </Flex>

          <EditClipLengthDialog
            projectId={clip.projectId}
            clipId={clip.id}
            clipTitle={clip.title}
            initialStartSec={clip.startSec}
            initialEndSec={clip.endSec}
            sourceVideoUrl={sourceVideoUrl}
            // Auto-reframe re-renders what the clip already had; a clip with
            // no renders yet reframes into the row's selected format.
            renderAspectRatios={
              clip.renderVariants.filter((v) => v.hasAsset).length > 0
                ? [...new Set(clip.renderVariants.filter((v) => v.hasAsset).map((v) => v.aspectRatio))]
                : [selectedAspectRatio]
            }
            open={editingBoundaries}
            onOpenChange={setEditingBoundaries}
          />

          {visibleError ? (
            <Flex role="alert" align="center" gap="1.5" color="danger.fg">
              <AlertTriangle size={12} aria-hidden />
              <Text fontSize="xs">{visibleError}</Text>
            </Flex>
          ) : null}
        </Stack>
      </Flex>
      {dialog}
    </Box>
  );
}
