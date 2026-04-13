"use client";

import type { SyntheticEvent } from "react";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScoreBadge } from "@narriflow/ui/components/score-badge";
import { Badge } from "@narriflow/ui/components/badge";
import { Button } from "@narriflow/ui/components/button";
import {
  clipAspectRatioOptions,
  type ClipAspectRatio,
  type ClipSnapshot,
} from "@narriflow/validators";
import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Loader,
  Pencil,
  Scissors,
  X,
} from "lucide-react";

const categoryColors: Record<string, string> = {
  hook: "blue",
  insight: "purple",
  story: "cyan",
  humor: "yellow",
  controversy: "red",
  emotional: "pink",
  tutorial: "green",
  quote: "orange",
  debate: "teal",
  surprise: "violet",
};

const platformLabels = [
  { key: "tiktokScore" as const, label: "TikTok" },
  { key: "youtubeScore" as const, label: "YouTube" },
  { key: "instagramScore" as const, label: "Instagram" },
];

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

function formatTimestamp(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function SubScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <Flex align="center" gap="8px" fontSize="11px">
      <Text color="fg.muted" w="70px" flexShrink={0}>
        {label}
      </Text>
      <Box flex="1" h="4px" bg="bg.muted" borderRadius="full" overflow="hidden">
        <Box
          h="full"
          borderRadius="full"
          bg={value >= 70 ? "success.solid" : value >= 40 ? "warning.solid" : "fg.subtle"}
          w={`${value}%`}
          transition="width 300ms ease"
        />
      </Box>
      <Text color="fg.subtle" w="24px" textAlign="right" fontFamily="mono">
        {value}
      </Text>
    </Flex>
  );
}

function ClipPreview({
  src,
  startSec,
  endSec,
  aspectRatioCss,
}: {
  src: string;
  startSec: number;
  endSec: number;
  aspectRatioCss: string;
}) {
  return (
    <Box
      borderRadius="8px"
      overflow="hidden"
      bg="bg.muted"
      mx="auto"
      css={{ aspectRatio: aspectRatioCss, maxHeight: "480px" }}
    >
      <video
        src={src}
        controls
        preload="metadata"
        style={{ width: "100%", height: "100%", display: "block" }}
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
    </Box>
  );
}

function RenderPreviewPlaceholder({
  aspectRatioCss,
  title,
  description,
}: {
  aspectRatioCss: string;
  title: string;
  description: string;
}) {
  return (
    <Box
      borderRadius="8px"
      bg="bg.muted"
      borderWidth="1px"
      borderColor="border"
      borderStyle="dashed"
      mx="auto"
      css={{ aspectRatio: aspectRatioCss, maxHeight: "480px" }}
      display="flex"
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
      gap="4px"
      px="16px"
      textAlign="center"
    >
      <Text fontSize="12px" color="fg" fontWeight="600">
        {title}
      </Text>
      <Text fontSize="11px" color="fg.muted" maxW="18rem">
        {description}
      </Text>
    </Box>
  );
}

export function ClipCard({
  clip,
  sourceVideoUrl,
  sourceType,
}: {
  clip: ClipSnapshot;
  sourceVideoUrl: string | null;
  sourceType: "upload" | "youtube" | "rss";
}) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [startSec, setStartSec] = useState(clip.startSec);
  const [endSec, setEndSec] = useState(clip.endSec);
  const [saving, setSaving] = useState(false);
  const [selectedAspectRatio, setSelectedAspectRatio] = useState<ClipAspectRatio>(
    () => getInitialAspectRatio(clip),
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
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
  const hasAnyRenderedVariant = clip.renderVariants.some((render) => render.hasAsset);
  const selectedStatus =
    queuedAspectRatios.includes(selectedAspectRatio)
      ? "rendering"
      : selectedVariant?.status ?? "missing";
  const selectedVariantHasAsset =
    Boolean(selectedVariant?.hasAsset) && !queuedAspectRatios.includes(selectedAspectRatio);

  useEffect(() => {
    let cancelled = false;

    if (!selectedVariantHasAsset) {
      setPreviewUrl(null);
      setPreviewLoading(false);
      return;
    }

    setPreviewLoading(true);
    fetch(
      `/api/projects/${clip.projectId}/clips/${clip.id}/download?aspectRatio=${encodeURIComponent(selectedAspectRatio)}`,
    )
      .then((response) => response.json())
      .then((data: { downloadUrl?: string }) => {
        if (!cancelled) {
          setPreviewUrl(data.downloadUrl ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewUrl(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    clip.id,
    clip.projectId,
    selectedAspectRatio,
    selectedVariantHasAsset,
    selectedVariant?.completedAt,
  ]);

  const categoryColor = categoryColors[clip.category] ?? "gray";

  async function handleStatusUpdate(status: "accepted" | "rejected") {
    setSaving(true);
    try {
      await fetch(`/api/projects/${clip.projectId}/clips/${clip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      startTransition(() => {
        router.refresh();
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleBoundarySave() {
    setSaving(true);
    try {
      await fetch(`/api/projects/${clip.projectId}/clips/${clip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startSec, endSec }),
      });
      setEditing(false);
      startTransition(() => {
        router.refresh();
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleRenderAspectRatio(aspectRatio: ClipAspectRatio) {
    setSelectedAspectRatio(aspectRatio);
    setQueuedAspectRatios((current) =>
      current.includes(aspectRatio) ? current : [...current, aspectRatio],
    );

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

    if (!response.ok) {
      setQueuedAspectRatios((current) =>
        current.filter((value) => value !== aspectRatio),
      );
      return;
    }

    startTransition(() => {
      router.refresh();
    });
  }

  async function handleDownload() {
    const response = await fetch(
      `/api/projects/${clip.projectId}/clips/${clip.id}/download?aspectRatio=${encodeURIComponent(selectedAspectRatio)}`,
    );
    const data = (await response.json()) as { downloadUrl?: string };
    if (data.downloadUrl) {
      window.open(data.downloadUrl, "_blank");
    }
  }

  return (
    <Box
      borderRadius="12px"
      borderWidth="1px"
      borderColor="border"
      bg="bg.panel"
      p="16px"
      transition="border-color 150ms ease"
      _hover={{ borderColor: "border.emphasized" }}
    >
      <Stack gap="12px">
        <Stack gap="8px">
          <Flex gap="8px" flexWrap="wrap">
            {clipAspectRatioOptions.map((option) => {
              const variant = renderVariantMap.get(option.value);
              const isSelected = option.value === selectedAspectRatio;
              const isQueued = queuedAspectRatios.includes(option.value);
              const status = isQueued ? "rendering" : variant?.status ?? "missing";
              const isAvailable = Boolean(variant?.hasAsset) && !isQueued;

              let suffix = "Render";
              if (status === "pending") suffix = "Pending";
              if (status === "rendering") suffix = "Rendering";
              if (status === "failed") suffix = "Retry";
              if (isAvailable) suffix = "Ready";

              const borderColor = isSelected
                ? "border.emphasized"
                : isAvailable
                  ? "success.border"
                  : status === "failed"
                    ? "danger.border"
                    : "border";

              return (
                <Box
                  key={option.value}
                  as="button"
                  px="10px"
                  py="6px"
                  borderRadius="999px"
                  borderWidth="1px"
                  borderColor={borderColor}
                  bg={isSelected ? "bg.muted" : "transparent"}
                  fontSize="11px"
                  opacity={status === "pending" || status === "rendering" ? 0.7 : 1}
                  cursor={
                    status === "pending" || status === "rendering"
                      ? "not-allowed"
                      : "pointer"
                  }
                  onClick={() => {
                    if (status === "pending" || status === "rendering") {
                      return;
                    }

                    if (isAvailable) {
                      setSelectedAspectRatio(option.value);
                      return;
                    }

                    void handleRenderAspectRatio(option.value);
                  }}
                  aria-disabled={status === "pending" || status === "rendering"}
                >
                  <Flex align="center" gap="6px">
                    <Text color="fg">{option.value}</Text>
                    <Text color="fg.muted">{suffix}</Text>
                  </Flex>
                </Box>
              );
            })}
          </Flex>

          {previewUrl && selectedVariantHasAsset ? (
            <ClipPreview
              src={previewUrl}
              startSec={0}
              endSec={clip.durationSec}
              aspectRatioCss={selectedOption.css}
            />
          ) : !hasAnyRenderedVariant &&
            sourceType !== "youtube" &&
            sourceVideoUrl ? (
            <ClipPreview
              src={sourceVideoUrl}
              startSec={clip.startSec}
              endSec={clip.endSec}
              aspectRatioCss={selectedOption.css}
            />
          ) : (
            <RenderPreviewPlaceholder
              aspectRatioCss={selectedOption.css}
              title={
                previewLoading
                  ? `Loading ${selectedAspectRatio} preview`
                  : selectedStatus === "rendering" || selectedStatus === "pending"
                    ? `${selectedAspectRatio} render is queued`
                    : selectedStatus === "failed"
                      ? `${selectedAspectRatio} render failed`
                      : `Render ${selectedAspectRatio} to preview`
              }
              description={
                selectedStatus === "failed" && selectedVariant?.errorCode
                  ? `Last error: ${selectedVariant.errorCode}`
                  : hasAnyRenderedVariant
                    ? "Only completed renders can be previewed. Pick a ready format or queue this one."
                    : "The source clip exists, but this aspect ratio has not been rendered yet."
              }
            />
          )}
        </Stack>

        <Flex align="center" justify="space-between" gap="8px">
          <HStack gap="8px">
            <Badge size="sm" colorPalette={categoryColor} variant="subtle">
              {clip.category}
            </Badge>
            <Text fontSize="11px" fontFamily="mono" color="fg.subtle">
              {formatTimestamp(clip.startSec)} – {formatTimestamp(clip.endSec)}
            </Text>
            <Text fontSize="11px" color="fg.muted">
              {clip.durationSec.toFixed(1)}s
            </Text>
          </HStack>
          <ScoreBadge score={clip.viralityScore} size="sm" />
        </Flex>

        <Text fontSize="14px" fontWeight="500" color="fg" lineHeight="1.5">
          {clip.hookText}
        </Text>

        <HStack gap="12px" flexWrap="wrap">
          {platformLabels.map(({ key, label }) => (
            <HStack key={key} gap="4px">
              <Text fontSize="11px" color="fg.muted">
                {label}
              </Text>
              <Text
                fontSize="11px"
                fontWeight="600"
                fontFamily="mono"
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
        </HStack>

        <Stack gap="4px">
          <SubScoreBar label="Hook" value={clip.hookStrengthScore} />
          <SubScoreBar label="Emotion" value={clip.emotionalIntensityScore} />
          <SubScoreBar label="Pacing" value={clip.pacingScore} />
          <SubScoreBar label="Duration" value={clip.durationOptimalityScore} />
        </Stack>

        <Button variant="ghost" size="xs" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          <Text ml="4px" fontSize="12px">
            {expanded ? "Less" : "More"}
          </Text>
        </Button>

        {expanded ? (
          <Stack gap="12px">
            <Box>
              <Text fontSize="11px" fontWeight="500" color="fg.muted" mb="4px">
                Why this clip
              </Text>
              <Text fontSize="13px" color="fg" lineHeight="1.6">
                {clip.reasoning}
              </Text>
            </Box>

            {clip.transcriptSlice.length > 0 ? (
              <Box>
                <Text fontSize="11px" fontWeight="500" color="fg.muted" mb="4px">
                  Transcript
                </Text>
                <Stack
                  maxH="12rem"
                  gap="0"
                  overflowY="auto"
                  borderRadius="8px"
                  borderWidth="1px"
                  borderColor="border"
                >
                  {clip.transcriptSlice.map((utterance, index) => (
                    <Box
                      key={`${utterance.index}-${utterance.startSec}`}
                      px="12px"
                      py="8px"
                      borderBottomWidth={
                        index < clip.transcriptSlice.length - 1 ? "1px" : "0"
                      }
                      borderColor="border"
                    >
                      <Flex gap="6px" align="center" mb="2px">
                        <Text fontSize="11px" fontWeight="500" color="fg">
                          {utterance.speakerLabel}
                        </Text>
                        <Text fontSize="10px" fontFamily="mono" color="fg.subtle">
                          {formatTimestamp(utterance.startSec)}
                        </Text>
                      </Flex>
                      <Text fontSize="12px" lineHeight="1.5" color="fg">
                        {utterance.text}
                      </Text>
                    </Box>
                  ))}
                </Stack>
              </Box>
            ) : null}
          </Stack>
        ) : null}

        {(selectedStatus === "pending" || selectedStatus === "rendering") && (
          <Flex align="center" gap="4px">
            <Loader size={12} className="animate-spin" />
            <Text fontSize="11px" color="fg.muted">
              {selectedStatus === "pending"
                ? `${selectedAspectRatio} render is queued`
                : `${selectedAspectRatio} render is processing`}
            </Text>
          </Flex>
        )}
        {selectedStatus === "failed" && selectedVariant?.errorCode ? (
          <Text fontSize="11px" color="danger.fg">
            Render failed: {selectedVariant.errorCode}
          </Text>
        ) : null}

        <Flex gap="8px" flexWrap="wrap">
          {selectedVariantHasAsset ? (
            <Button size="xs" variant="outline" onClick={handleDownload}>
              <Download size={12} />
              <Text ml="4px">Download {selectedAspectRatio}</Text>
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={selectedStatus === "pending" || selectedStatus === "rendering"}
              onClick={() => handleRenderAspectRatio(selectedAspectRatio)}
            >
              {selectedStatus === "pending" || selectedStatus === "rendering" ? (
                <Loader size={12} className="animate-spin" />
              ) : (
                <Check size={12} />
              )}
              <Text ml="4px">
                {selectedStatus === "failed"
                  ? `Retry ${selectedAspectRatio}`
                  : `Render ${selectedAspectRatio}`}
              </Text>
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            onClick={() => router.push(`/projects/${clip.projectId}/clips/${clip.id}/studio`)}
          >
            <Pencil size={12} />
            <Text ml="4px">Edit</Text>
          </Button>
          {clip.status !== "accepted" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={saving || isRefreshing}
              onClick={() => handleStatusUpdate("accepted")}
            >
              <Check size={12} />
              <Text ml="4px">Accept</Text>
            </Button>
          ) : null}
          {clip.status !== "rejected" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={saving || isRefreshing}
              onClick={() => handleStatusUpdate("rejected")}
            >
              <X size={12} />
              <Text ml="4px">Reject</Text>
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => setEditing(!editing)}>
            <Scissors size={12} />
            <Text ml="4px">Edit Boundaries</Text>
          </Button>
        </Flex>

        {editing ? (
          <Flex gap="8px" align="end" flexWrap="wrap">
            <Box>
              <Text fontSize="11px" color="fg.muted" mb="2px">
                Start (sec)
              </Text>
              <input
                type="number"
                step="0.1"
                min="0"
                value={startSec}
                onChange={(event) => setStartSec(Number(event.target.value))}
                style={{
                  width: "80px",
                  padding: "4px 8px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid var(--chakra-colors-border)",
                  background: "transparent",
                  color: "inherit",
                }}
              />
            </Box>
            <Box>
              <Text fontSize="11px" color="fg.muted" mb="2px">
                End (sec)
              </Text>
              <input
                type="number"
                step="0.1"
                min="0"
                value={endSec}
                onChange={(event) => setEndSec(Number(event.target.value))}
                style={{
                  width: "80px",
                  padding: "4px 8px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid var(--chakra-colors-border)",
                  background: "transparent",
                  color: "inherit",
                }}
              />
            </Box>
            <Button size="xs" onClick={handleBoundarySave} disabled={saving || isRefreshing}>
              <Text>{saving ? "Saving..." : "Save"}</Text>
            </Button>
          </Flex>
        ) : null}
      </Stack>
    </Box>
  );
}
