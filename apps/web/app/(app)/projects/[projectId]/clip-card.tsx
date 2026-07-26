"use client";

import type { SyntheticEvent } from "react";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ScoreMeter } from "@narriflow/ui/components/meter";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { NumberInput } from "@narriflow/ui/components/number-input";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import {
  clipAspectRatioOptions,
  userErrorMessage,
  type ClipAspectRatio,
  type ClipSnapshot,
} from "@narriflow/validators";
import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Pencil,
  Scissors,
  X,
} from "lucide-react";
import { formatDuration, formatTimecode } from "@/lib/format";

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

  if (preferred) {
    return preferred.aspectRatio;
  }

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

function downloadUrlFromPayload(payload: unknown): string | null {
  const value = readPayloadString(payload, "downloadUrl");
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
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

function ClipVideo({
  src,
  startSec,
  endSec,
}: {
  src: string;
  startSec: number;
  endSec: number;
}) {
  return (
    // biome-ignore lint/a11y/useMediaCaption: preview player for a clip segment; no caption/VTT source is available in this component.
    <video
      src={src}
      controls
      preload="metadata"
      style={{ width: "100%", height: "100%", display: "block", objectFit: "contain" }}
      onLoadedMetadata={(event: SyntheticEvent<HTMLVideoElement>) => {
        event.currentTarget.currentTime = startSec;
      }}
      onTimeUpdate={(event: SyntheticEvent<HTMLVideoElement>) => {
        const video = event.currentTarget;
        if (video.currentTime >= endSec) {
          video.pause();
          video.currentTime = startSec;
        }
      }}
    />
  );
}

/**
 * Ghost-frame motif for unrendered formats — a small dashed frame in the
 * clip's aspect ratio plus ONE mono caption. Sits on the graphite well, so
 * it draws with studio.* tokens (mode-invariant footage chrome).
 */
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
    <Flex
      w="full"
      h="full"
      direction="column"
      align="center"
      justify="center"
      gap="3"
      px="4"
    >
      <Box
        position="relative"
        w="52px"
        borderWidth="1px"
        borderStyle="dashed"
        borderColor="studio.borderControl"
        borderRadius="l1"
        overflow="hidden"
        css={{ aspectRatio: aspectCss }}
        aria-hidden="true"
      >
        <Box position="absolute" inset="0" color="studio.border">
          <svg
            width="100%"
            height="100%"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            <line
              x1="0"
              y1="0"
              x2="100"
              y2="100"
              stroke="currentColor"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1="100"
              y1="0"
              x2="0"
              y2="100"
              stroke="currentColor"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </Box>
        {loading && (
          <Flex position="absolute" inset="0" align="center" justify="center">
            <Spinner size="xs" />
          </Flex>
        )}
      </Box>
      <Text
        textStyle="data"
        fontSize="11px"
        color="studio.fgSubtle"
        textAlign="center"
      >
        {caption}
      </Text>
    </Flex>
  );
}

const stripeByStatus: Record<string, string | null> = {
  accepted: "success.solid",
  rejected: "danger.solid",
};

export function ClipCard({
  clip,
}: {
  clip: ClipSnapshot;
  // Kept in the prop type for compatibility with the (unowned) project page,
  // which still presigns and passes these down — but the inline preview
  // below no longer plays the full source directly (see Problem A: that
  // used to cost a ~44s metadata load per card). It's the rendered-output
  // download path only now.
  sourceVideoUrl: string | null;
  sourceType: "upload" | "youtube" | "rss" | "link";
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [isRefreshing, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [startSec, setStartSec] = useState(clip.startSec);
  const [endSec, setEndSec] = useState(clip.endSec);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedAspectRatio, setSelectedAspectRatio] = useState<ClipAspectRatio>(
    () => getInitialAspectRatio(clip),
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // True when previewUrl points at the lightweight proxy (aspect-ratio
  // agnostic, source-time shifted by previewOffsetSec) rather than a
  // finished render (which is already cropped/captioned — plays 0..duration).
  const [previewIsProxy, setPreviewIsProxy] = useState(false);
  const [previewOffsetSec, setPreviewOffsetSec] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Distinct from previewError: "nothing to show yet" is expected/transient,
  // not a failure — see the WellPlaceholder caption below.
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [queuedAspectRatios, setQueuedAspectRatios] = useState<ClipAspectRatio[]>([]);

  useEffect(() => {
    setSelectedAspectRatio(getInitialAspectRatio(clip));
    setQueuedAspectRatios([]);
  }, [clip.id, clip.renderVariants]);

  const renderVariantMap = new Map(
    clip.renderVariants.map((render) => [render.aspectRatio, render]),
  );
  const selectedVariant = renderVariantMap.get(selectedAspectRatio) ?? null;
  const selectedOption =
    clipAspectRatioOptions.find((option) => option.value === selectedAspectRatio) ??
    clipAspectRatioOptions[0]!;
  const selectedStatus =
    queuedAspectRatios.includes(selectedAspectRatio)
      ? "rendering"
      : selectedVariant?.status ?? "missing";
  const selectedVariantHasAsset =
    Boolean(selectedVariant?.hasAsset) && !queuedAspectRatios.includes(selectedAspectRatio);

  // Always tries to load *something* playable for the card — a finished
  // render when one exists for the selected format, else the clip's
  // lightweight preview proxy (the same /download endpoint falls back to it
  // server-side; see clip.service.ts's getClipDownloadUrl). Only when
  // neither exists yet do we show the honest "preview generating…" state —
  // never the old behaviour of streaming the full multi-hundred-MB source
  // client-side just to preview a few seconds of footage.
  useEffect(() => {
    let cancelled = false;

    const loadPreview = async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      setPreviewPending(false);
      try {
        const response = await fetch(
          `/api/projects/${clip.projectId}/clips/${clip.id}/download?aspectRatio=${encodeURIComponent(selectedAspectRatio)}`,
        );
        const payload: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          const message = readPayloadString(payload, "message");
          // These two specific messages mean "nothing to preview yet" (no
          // completed render AND no proxy) — an expected, transient state
          // while detection/rendering/proxy-generation catch up, not an
          // error worth alarming the user about.
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

          console.error("clip_preview_load_failed", response.status);
          if (!cancelled) {
            setPreviewUrl(null);
            setPreviewError(
              apiErrorCopy(payload, "Could not load this preview. Please try again."),
            );
          }
          return;
        }

        const downloadUrl = downloadUrlFromPayload(payload);
        if (!downloadUrl) {
          console.error("clip_preview_load_failed_invalid_response");
          if (!cancelled) {
            setPreviewUrl(null);
            setPreviewError("Could not load this preview. Please try again.");
          }
          return;
        }

        if (!cancelled) {
          const isProxy =
            payload !== null &&
            typeof payload === "object" &&
            (payload as Record<string, unknown>).isPreviewProxy === true;
          const rawOffset =
            payload !== null && typeof payload === "object"
              ? (payload as Record<string, unknown>).previewStartSec
              : undefined;

          setPreviewUrl(downloadUrl);
          setPreviewIsProxy(isProxy);
          setPreviewOffsetSec(
            typeof rawOffset === "number" && Number.isFinite(rawOffset) ? rawOffset : 0,
          );
        }
      } catch {
        console.error("clip_preview_load_failed");
        if (!cancelled) {
          setPreviewUrl(null);
          setPreviewError("Could not load this preview. Please try again.");
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    };

    void loadPreview();

    return () => {
      cancelled = true;
    };
  }, [
    clip.id,
    clip.projectId,
    selectedAspectRatio,
    selectedVariantHasAsset,
    selectedVariant?.status,
    selectedVariant?.completedAt,
  ]);

  async function handleStatusUpdate(status: "accepted" | "rejected") {
    setSaving(true);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/projects/${clip.projectId}/clips/${clip.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        console.error("clip_status_update_failed", response.status, body);
        setActionError(
          userErrorMessage(body?.error) ??
            "Could not update this clip. Please try again.",
        );
        return;
      }
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      console.error("clip_status_update_failed", err);
      setActionError("Could not update this clip. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleBoundarySave() {
    setSaving(true);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/projects/${clip.projectId}/clips/${clip.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startSec, endSec }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        console.error("clip_boundary_save_failed", response.status, body);
        setActionError(
          userErrorMessage(body?.error) ??
            "Could not save these boundaries. Please try again.",
        );
        return;
      }
      setEditing(false);
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      console.error("clip_boundary_save_failed", err);
      setActionError("Could not save these boundaries. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function snapBoundariesToTranscript() {
    if (clip.transcriptSlice.length === 0) {
      return;
    }

    setStartSec(clip.transcriptSlice[0]!.startSec);
    setEndSec(clip.transcriptSlice.at(-1)!.endSec);
  }

  async function queueRender(aspectRatio: ClipAspectRatio) {
    setSelectedAspectRatio(aspectRatio);
    setQueuedAspectRatios((current) =>
      current.includes(aspectRatio) ? current : [...current, aspectRatio],
    );
    setActionError(null);
    let accepted = false;

    try {
      const response = await fetch(`/api/projects/${clip.projectId}/clips/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          clipIds: [clip.id],
          aspectRatios: [aspectRatio],
        }),
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        console.error("clip_render_queue_failed", response.status);
        setActionError(
          apiErrorCopy(payload, "Could not queue this render. Please try again."),
        );
        return;
      }
      if (!isRenderQueueResponse(payload)) {
        console.error("clip_render_queue_invalid_response");
        setActionError(
          "The render may have queued, but the response was incomplete. Refresh to check its status.",
        );
        return;
      }

      accepted = true;
      startTransition(() => {
        router.refresh();
      });
    } catch {
      console.error("clip_render_queue_failed");
      setActionError("Could not queue this render. Please try again.");
    } finally {
      if (!accepted) {
        setQueuedAspectRatios((current) =>
          current.filter((value) => value !== aspectRatio),
        );
      }
    }
  }

  async function handleRenderWithConfirm(aspectRatio: ClipAspectRatio) {
    const isRetry = renderVariantMap.get(aspectRatio)?.status === "failed";
    const confirmed = await confirm({
      title: isRetry
        ? `Retry the ${aspectRatio} render?`
        : `Queue a ${aspectRatio} render?`,
      description:
        "Rendering burns captions into a new video file and uses render capacity on your plan.",
      confirmLabel: isRetry ? "Retry render" : "Queue render",
    });
    if (!confirmed) return;
    await queueRender(aspectRatio);
  }

  async function handleDownload() {
    if (downloading) return;

    setDownloading(true);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/projects/${clip.projectId}/clips/${clip.id}/download?aspectRatio=${encodeURIComponent(selectedAspectRatio)}`,
      );
      const payload: unknown = await response.json().catch(() => null);
      const downloadUrl = downloadUrlFromPayload(payload);
      if (!response.ok || !downloadUrl) {
        console.error("clip_download_failed", response.status);
        setActionError(
          apiErrorCopy(payload, "Could not prepare this download. Please try again."),
        );
        return;
      }

      window.location.assign(downloadUrl);
    } catch {
      console.error("clip_download_failed");
      setActionError("Could not prepare this download. Please try again.");
    } finally {
      setDownloading(false);
    }
  }

  const stripe = stripeByStatus[clip.status] ?? null;
  const studioHref = `/projects/${clip.projectId}/clips/${clip.id}/studio`;
  const outsidePreferredRange = clip.durationSec < 30 || clip.durationSec > 60;
  const visibleError = actionError ?? previewError;

  return (
    <Box
      position="relative"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l2"
      overflow="hidden"
      bg="bg"
      transition="border-color 120ms ease, background 120ms ease"
      _hover={{ borderColor: "border.emphasized" }}
    >
      {/* 3px status stripe — accepted/rejected state, label carried below */}
      {stripe && (
        <Box
          position="absolute"
          insetInlineStart="0"
          top="0"
          bottom="0"
          w="3px"
          bg={stripe}
          zIndex={1}
        />
      )}

      <Stack gap="0">
        {/* Footage — always in a well. Inlined (not MediaWell) because the
            aspect ratio is dynamic per selected format — intentional, not drift. */}
        <Box
          position="relative"
          bg="studio.subtle"
          borderBottomWidth="1px"
          borderColor="border"
          css={{ aspectRatio: selectedOption.css, maxHeight: "420px" }}
        >
          {previewUrl ? (
            <ClipVideo
              src={previewUrl}
              // A finished render is already cropped to just this clip
              // (plays 0..duration); the proxy instead covers a padded
              // source-time window, so its own t=0 is previewOffsetSec
              // seconds *before* the clip's source-time start — shift by
              // that offset or every trim/caption reference would be off.
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
                  ? "Loading preview"
                  : previewPending
                    ? selectedStatus === "failed"
                      ? `${selectedAspectRatio} render failed`
                      : "Preview generating…"
                    : "Preview unavailable"
              }
            />
          )}
          {/* Mono duration chip */}
          <Box
            position="absolute"
            bottom="1.5"
            insetInlineEnd="1.5"
            px="1.5"
            py="0.5"
            borderRadius="l1"
            bg="rgba(14, 16, 19, 0.72)"
            color="studio.timecode"
            textStyle="data"
            fontSize="11px"
            lineHeight="1.4"
            pointerEvents="none"
          >
            {formatDuration(clip.durationSec)}
          </Box>
        </Box>

        <Stack gap="2.5" p="3" ps={stripe ? "4" : "3"}>
          <Flex align="flex-start" justify="space-between" gap="3">
            <Box minW="0">
              <HStack gap="2" mb="1">
                <Text
                  textStyle="eyebrow"
                  color={clip.category === "hook" ? "accent.fg" : "fg.subtle"}
                >
                  {clip.category}
                </Text>
                {(clip.status === "accepted" || clip.status === "rejected") && (
                  <Text
                    textStyle="eyebrow"
                    color={clip.status === "accepted" ? "success.fg" : "danger.fg"}
                  >
                    {clip.status}
                  </Text>
                )}
              </HStack>
              <Link href={studioHref}>
                <Text
                  fontSize="sm"
                  fontWeight="500"
                  color="fg"
                  lineHeight="1.45"
                  lineClamp={2}
                  textDecoration="underline"
                  textDecorationColor="transparent"
                  textUnderlineOffset="3px"
                  transition="text-decoration-color 120ms ease"
                  _hover={{ textDecorationColor: "border.emphasized" }}
                >
                  {clip.title ?? clip.hookText}
                </Text>
              </Link>
              <Text mt="1" textStyle="data" fontSize="11px" color="fg.timecode">
                {formatTimecode(clip.startSec)} – {formatTimecode(clip.endSec)}
              </Text>
            </Box>
            <ScoreMeter score={clip.viralityScore} size="sm" />
          </Flex>

          {clip.title ? (
            <Text fontSize="xs" color="fg.muted" lineHeight="1.5" lineClamp={2}>
              {clip.hookText}
            </Text>
          ) : null}

          {outsidePreferredRange && (
            <Flex align="center" gap="1.5" color="warning.fg">
              <AlertTriangle size={12} aria-hidden />
              <Text fontSize="11px">Outside preferred 30–60s range.</Text>
            </Flex>
          )}

          {/* Format pills — SELECT ONLY. Rendering is queued via the explicit CTA below.
              Rendered = solid border + check; unrendered = dashed + subtle;
              selected = accent border. */}
          <Flex gap="1.5" wrap="wrap" role="radiogroup" aria-label="Preview format">
            {clipAspectRatioOptions.map((option) => {
              const variant = renderVariantMap.get(option.value);
              const isSelected = option.value === selectedAspectRatio;
              const isQueued = queuedAspectRatios.includes(option.value);
              const status = isQueued ? "rendering" : variant?.status ?? "missing";
              const isAvailable = Boolean(variant?.hasAsset) && !isQueued;
              const isInFlight = status === "pending" || status === "rendering";

              const stateWord = isAvailable
                ? "rendered"
                : isInFlight
                  ? "rendering"
                  : status === "failed"
                    ? "failed"
                    : "not rendered";

              return (
                <Box
                  key={option.value}
                  as="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={`${option.value} — ${stateWord}`}
                  px="2"
                  py="1"
                  borderRadius="l1"
                  borderWidth="1px"
                  borderStyle={isAvailable || isSelected ? "solid" : "dashed"}
                  borderColor={
                    isSelected
                      ? "accent.solid"
                      : isAvailable
                        ? "border.emphasized"
                        : "border"
                  }
                  cursor="pointer"
                  transition="border-color 120ms ease, background 120ms ease"
                  _hover={{ borderColor: isSelected ? "accent.solid" : "border.emphasized" }}
                  onClick={() => setSelectedAspectRatio(option.value)}
                >
                  <Flex align="center" gap="1">
                    <Text
                      textStyle="data"
                      fontSize="11px"
                      color={isAvailable || isSelected ? "fg" : "fg.subtle"}
                    >
                      {option.value}
                    </Text>
                    {isAvailable && (
                      <Box asChild color="success.fg" aria-hidden="true">
                        <Check size={10} strokeWidth={3} />
                      </Box>
                    )}
                    {isInFlight && <Spinner size="xs" />}
                    {status === "failed" && !isAvailable && !isInFlight && (
                      <Box asChild color="danger.fg" aria-hidden="true">
                        <AlertTriangle size={10} />
                      </Box>
                    )}
                  </Flex>
                </Box>
              );
            })}
          </Flex>

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
              <Text fontSize="11px">
                Render failed: {userErrorMessage(selectedVariant.errorCode)}
              </Text>
            </Flex>
          ) : null}

          {/* Footer row 1 — primary render/download action + Studio, fixed halves */}
          <Flex gap="1.5" align="center">
            {selectedVariantHasAsset ? (
              <Button
                size="xs"
                variant="outline"
                flex="1"
                minW="0"
                disabled={downloading}
                onClick={handleDownload}
              >
                {downloading ? <Spinner size="xs" /> : <Download size={12} />}
                <Text ms="1" truncate>
                  {downloading
                    ? "Preparing download…"
                    : `Download ${selectedAspectRatio}`}
                </Text>
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                flex="1"
                minW="0"
                disabled={selectedStatus === "pending" || selectedStatus === "rendering"}
                onClick={() => handleRenderWithConfirm(selectedAspectRatio)}
              >
                {selectedStatus === "pending" || selectedStatus === "rendering" ? (
                  <Spinner size="xs" />
                ) : (
                  <Check size={12} />
                )}
                <Text ms="1" truncate>
                  {selectedStatus === "failed"
                    ? `Retry ${selectedAspectRatio}`
                    : `Render ${selectedAspectRatio}`}
                </Text>
              </Button>
            )}
            <Button size="xs" variant="outline" flex="1" minW="0" asChild>
              <Link href={studioHref}>
                <Pencil size={12} />
                <Text ms="1">Studio</Text>
              </Link>
            </Button>
          </Flex>

          {/* Footer row 2 — quiet review actions, Details disclosure right */}
          <Flex gap="1" align="center">
            {clip.status !== "accepted" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={saving || isRefreshing}
                onClick={() => handleStatusUpdate("accepted")}
              >
                <Check size={12} />
                <Text ms="1">Accept</Text>
              </Button>
            ) : null}
            {clip.status !== "rejected" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={saving || isRefreshing}
                onClick={() => handleStatusUpdate("rejected")}
              >
                <X size={12} />
                <Text ms="1">Reject</Text>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              ms="auto"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              <Text me="1" fontSize="xs">
                {expanded ? "Less" : "Details"}
              </Text>
              {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </Button>
          </Flex>

          {expanded ? (
            <Stack gap="3" pt="1" borderTopWidth="1px" borderColor="border.subtle">
              <HStack gap="3" wrap="wrap" pt="2">
                {platformLabels.map(({ key, label }) => (
                  <HStack key={key} gap="1">
                    <Text fontSize="11px" color="fg.muted">
                      {label}
                    </Text>
                    <Text
                      textStyle="data"
                      fontSize="11px"
                      fontWeight="600"
                      color={
                        clip[key] >= 70
                          ? "success.fg"
                          : clip[key] >= 40
                            ? "warning.fg"
                            : "fg.muted"
                      }
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

              <Stack gap="1">
                <SubScoreBar label="Hook" value={clip.hookStrengthScore} />
                <SubScoreBar label="Emotion" value={clip.emotionalIntensityScore} />
                <SubScoreBar label="Story" value={clip.storyCompletenessScore} />
                <SubScoreBar label="Pacing" value={clip.pacingScore} />
                <SubScoreBar label="Duration" value={clip.durationOptimalityScore} />
              </Stack>

              <Box>
                <Text textStyle="eyebrow" color="fg.subtle" mb="1">
                  Why this clip
                </Text>
                <Text fontSize="xs" color="fg" lineHeight="1.6">
                  {clip.reasoning}
                </Text>
                {clip.payoffText ? (
                  <Text mt="1.5" fontSize="xs" color="fg.muted" lineHeight="1.6">
                    Payoff: {clip.payoffText}
                  </Text>
                ) : null}
              </Box>

              {clip.transcriptSlice.length > 0 ? (
                <Box>
                  <Text textStyle="eyebrow" color="fg.subtle" mb="1">
                    Transcript
                  </Text>
                  <Stack maxH="10rem" gap="0" overflowY="auto">
                    {clip.transcriptSlice.map((utterance, index) => (
                      <Box
                        key={`${utterance.index}-${utterance.startSec}`}
                        py="2"
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
                        <Text fontSize="xs" lineHeight="1.5" color="fg">
                          {utterance.text}
                        </Text>
                      </Box>
                    ))}
                  </Stack>
                </Box>
              ) : null}

              <Button
                size="xs"
                variant="ghost"
                alignSelf="flex-start"
                onClick={() => setEditing(!editing)}
              >
                <Scissors size={12} />
                <Text ms="1">Edit boundaries</Text>
              </Button>

              {editing ? (
                <Flex gap="2" align="flex-end" wrap="wrap">
                  <Box w="90px">
                    <Text fontSize="11px" color="fg.muted" mb="0.5">
                      Start (sec)
                    </Text>
                    <NumberInput
                      size="sm"
                      value={String(startSec)}
                      onValueChange={(_, valueAsNumber) => {
                        if (Number.isFinite(valueAsNumber)) {
                          setStartSec(valueAsNumber);
                        }
                      }}
                      min={0}
                      step={0.1}
                    />
                  </Box>
                  <Box w="90px">
                    <Text fontSize="11px" color="fg.muted" mb="0.5">
                      End (sec)
                    </Text>
                    <NumberInput
                      size="sm"
                      value={String(endSec)}
                      onValueChange={(_, valueAsNumber) => {
                        if (Number.isFinite(valueAsNumber)) {
                          setEndSec(valueAsNumber);
                        }
                      }}
                      min={0}
                      step={0.1}
                    />
                  </Box>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={handleBoundarySave}
                    disabled={saving || isRefreshing}
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    type="button"
                    onClick={snapBoundariesToTranscript}
                    disabled={clip.transcriptSlice.length === 0}
                  >
                    Snap to Transcript
                  </Button>
                </Flex>
              ) : null}
            </Stack>
          ) : null}

          {visibleError ? (
            <Flex role="alert" align="center" gap="1.5" color="danger.fg">
              <AlertTriangle size={12} aria-hidden />
              <Text fontSize="xs">{visibleError}</Text>
            </Flex>
          ) : null}
        </Stack>
      </Stack>
      {dialog}
    </Box>
  );
}
