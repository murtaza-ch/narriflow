"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Box,
  Flex,
  Grid,
  HStack,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Film,
  Link2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button, MediaWell, Progress, Spinner, StatusBadge } from "@narriflow/ui";
import type { ClipExportSnapshot } from "@narriflow/validators";
import { formatDateTime, formatDuration } from "@/lib/format";

const ACTIVE_STATUSES = new Set(["queued", "rendering", "partial_ready"]);

function formatBytes(value: number | null): string {
  if (value === null || value < 0) return "—";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function statusCopy(status: ClipExportSnapshot["status"]) {
  switch (status) {
    case "ready":
      return { label: "Ready", detail: "Every requested variant is ready to deliver." };
    case "partial_ready":
      return { label: "Partially ready", detail: "Ready variants are available; failed ones can be retried." };
    case "failed":
      return { label: "Failed", detail: "No variant completed. Retry the failed render." };
    case "rendering":
      return { label: "Rendering", detail: "Your saved version is rendering in the background." };
    default:
      return { label: "Queued", detail: "Your export is waiting for render capacity." };
  }
}

export function ExportDeliveryClient({
  initialExport,
  initialSeq,
}: {
  initialExport: ClipExportSnapshot;
  initialSeq: number;
}) {
  const [data, setData] = useState(initialExport);
  const [selectedVariantId, setSelectedVariantId] = useState(
    initialExport.variants.find((variant) => variant.hasAsset)?.id ??
      initialExport.variants[0]?.id ??
      "",
  );
  const [sharePath, setSharePath] = useState<string | null>(null);
  const [action, setAction] = useState<"share" | "retry" | "revoke" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const lastSeqRef = useRef(initialSeq);

  const apiPath = `/api/projects/${data.projectId}/clips/${data.clipId}/exports/${data.id}`;
  const refresh = useCallback(async () => {
    const response = await fetch(apiPath, { cache: "no-store" });
    if (!response.ok) return;
    const next = (await response.json()) as ClipExportSnapshot;
    setData(next);
    setSelectedVariantId((current) =>
      next.variants.some((variant) => variant.id === current && variant.hasAsset)
        ? current
        : next.variants.find((variant) => variant.hasAsset)?.id ?? current,
    );
  }, [apiPath]);

  useEffect(() => {
    if (!ACTIVE_STATUSES.has(data.status)) return;
    let fallback: ReturnType<typeof setInterval> | null = null;
    const source = new EventSource(
      `/api/stream/${data.projectId}?sinceSeq=${lastSeqRef.current}`,
    );
    const onUpdate = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { stage?: unknown; seq?: unknown };
        if (typeof payload.seq === "number") {
          lastSeqRef.current = Math.max(lastSeqRef.current, payload.seq);
        }
        if (payload.stage !== "clip_rendering") return;
      } catch {
        return;
      }
      void refresh();
    };
    source.addEventListener("workflow.stage.updated", onUpdate);
    source.onerror = () => {
      source.close();
      if (fallback !== null) clearInterval(fallback);
      fallback = setInterval(() => {
        if (document.visibilityState === "visible") void refresh();
      }, 5_000);
    };
    fallback = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10_000);
    return () => {
      source.removeEventListener("workflow.stage.updated", onUpdate);
      source.close();
      if (fallback !== null) clearInterval(fallback);
    };
  }, [data.projectId, data.status, initialSeq, refresh]);

  const selected =
    data.variants.find((variant) => variant.id === selectedVariantId) ??
    data.variants.find((variant) => variant.hasAsset) ??
    data.variants[0];
  const copy = statusCopy(data.status);
  const hasReady = data.variants.some((variant) => variant.hasAsset);
  const hasFailed = data.variants.some((variant) => variant.status === "failed");
  const shareUrl = useMemo(
    () => (sharePath && typeof window !== "undefined" ? `${window.location.origin}${sharePath}` : null),
    [sharePath],
  );

  async function createShareLink() {
    setAction("share");
    setActionError(null);
    try {
      const response = await fetch(`${apiPath}/share-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays: 7 }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.path) throw new Error("share_failed");
      setSharePath(body.path);
      await navigator.clipboard.writeText(`${window.location.origin}${body.path}`);
    } catch {
      setActionError("The private link could not be created. Try again.");
    } finally {
      setAction(null);
    }
  }

  async function copyShareLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      setActionError("Copy was blocked by the browser. Select the link manually.");
    }
  }

  async function revokeLinks() {
    setAction("revoke");
    setActionError(null);
    try {
      const response = await fetch(`${apiPath}/share-links`, { method: "DELETE" });
      if (!response.ok) throw new Error("revoke_failed");
      setSharePath(null);
    } catch {
      setActionError("Share links could not be revoked. Try again.");
    } finally {
      setAction(null);
    }
  }

  async function retry() {
    setAction("retry");
    setActionError(null);
    try {
      const response = await fetch(`${apiPath}/retry`, { method: "POST" });
      if (!response.ok) throw new Error("retry_failed");
      const next = (await response.json()) as ClipExportSnapshot;
      if (next) setData(next);
    } catch {
      setActionError("The failed variants could not be requeued. Try again.");
    } finally {
      setAction(null);
    }
  }

  return (
    <Box minH="100dvh" bg="bg.canvas" layerStyle="blueprint">
      <Flex
        as="header"
        minH="56px"
        align="center"
        justify="space-between"
        px={{ base: "4", md: "6" }}
        py="2"
        bg="bg.surface"
        borderBottomWidth="1px"
        borderColor="border"
      >
        <HStack gap="3" minW="0">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/projects/${data.projectId}/clips/${data.clipId}/studio`}>
              <ArrowLeft size={15} /> Studio
            </Link>
          </Button>
          <Box w="1px" h="22px" bg="border" />
          <Box minW="0">
            <Text textStyle="eyebrow" color="fg.subtle">
              Export delivery
            </Text>
            <Text fontFamily="display" fontWeight="600" fontSize="14px" truncate>
              {data.clipTitle}
            </Text>
          </Box>
        </HStack>
        <StatusBadge
          status={data.status === "ready" ? "completed" : data.status === "failed" ? "failed" : "processing"}
          label={copy.label}
        />
      </Flex>

      <Box maxW="1240px" mx="auto" px={{ base: "4", md: "6" }} py={{ base: "5", md: "8" }}>
        {data.isOlderVersion ? (
          <Flex
            align={{ base: "flex-start", sm: "center" }}
            direction={{ base: "column", sm: "row" }}
            justify="space-between"
            gap="3"
            mb="5"
            px="4"
            py="3"
            borderStartWidth="3px"
            borderColor="accent.solid"
            bg="bg.surface"
          >
            <Box>
              <Text fontWeight="600" fontSize="13px">A newer editor version exists</Text>
              <Text fontSize="12px" color="fg.muted">
                This delivery stays pinned to version {data.editorRevision}. Open Studio to export version {data.currentEditorRevision}.
              </Text>
            </Box>
            <Button asChild size="sm" variant="outline">
              <Link href={`/projects/${data.projectId}/clips/${data.clipId}/studio`}>Export newer version</Link>
            </Button>
          </Flex>
        ) : null}

        <Grid templateColumns={{ base: "1fr", lg: "minmax(0, 1.65fr) minmax(300px, 0.75fr)" }} gap="6">
          <Stack gap="4" minW="0">
            <MediaWell
              ratio={selected?.aspectRatio === "9:16" ? 9 / 16 : selected?.aspectRatio === "1:1" ? 1 : selected?.aspectRatio === "4:5" ? 4 / 5 : 16 / 9}
              maxH={{ base: "70dvh", lg: "calc(100dvh - 190px)" }}
              mx="auto"
              w="full"
              timecode={selected?.durationSec ? formatDuration(selected.durationSec) : undefined}
            >
              {selected?.downloadUrl ? (
                <Box asChild w="full" h="full" bg="studio.canvas">
                  {/* biome-ignore lint/a11y/useMediaCaption: This is the final rendered export, which already burns the user's configured captions into the video. */}
                  <video controls playsInline preload="metadata" src={selected.previewUrl ?? selected.downloadUrl} aria-label={`${selected.aspectRatio} exported video`} />
                </Box>
              ) : (
                <Flex h="full" minH="320px" align="center" justify="center" direction="column" gap="3" color="studio.fgMuted">
                  {data.status === "failed" ? <AlertTriangle size={28} /> : <Spinner size="md" />}
                  <Text fontSize="13px">{data.status === "failed" ? "Render failed" : "Rendering your saved version"}</Text>
                </Flex>
              )}
            </MediaWell>

            <Flex gap="2" wrap="wrap" aria-label="Export variants">
              {data.variants.map((variant) => (
                <Button
                  key={variant.id}
                  size="sm"
                  variant={variant.id === selected?.id ? "solid" : "outline"}
                  colorPalette={variant.id === selected?.id ? "accent" : undefined}
                  disabled={!variant.hasAsset}
                  onClick={() => setSelectedVariantId(variant.id)}
                  aria-pressed={variant.id === selected?.id}
                >
                  {variant.status === "completed" ? <Check size={12} /> : variant.status === "failed" ? <AlertTriangle size={12} /> : <Clock3 size={12} />}
                  {variant.aspectRatio}
                </Button>
              ))}
            </Flex>
          </Stack>

          <Stack gap="4">
            <Box layerStyle="panel" p="5">
              <Stack gap="4">
                <Box>
                  <Text textStyle="eyebrow" color="fg.subtle">Delivery status</Text>
                  <Flex align="baseline" justify="space-between" gap="3" mt="1">
                    <Text fontFamily="display" fontSize="22px" fontWeight="600">{copy.label}</Text>
                    <Text textStyle="data" fontSize="12px" color="fg.muted">{data.progress}%</Text>
                  </Flex>
                  <Text fontSize="12px" color="fg.muted" mt="1">{copy.detail}</Text>
                </Box>
                <Box role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={data.progress}>
                  <Progress value={data.progress} />
                </Box>
                <Grid templateColumns="1fr 1fr" gap="3" pt="3" borderTopWidth="1px" borderColor="border">
                  <Box><Text textStyle="eyebrow" color="fg.subtle">Version</Text><Text textStyle="data" fontSize="12px">v{data.editorRevision}</Text></Box>
                  <Box><Text textStyle="eyebrow" color="fg.subtle">Created</Text><Text textStyle="data" fontSize="11px">{formatDateTime(data.createdAt)}</Text></Box>
                  <Box><Text textStyle="eyebrow" color="fg.subtle">Resolution</Text><Text textStyle="data" fontSize="12px">{data.resolution}</Text></Box>
                  <Box><Text textStyle="eyebrow" color="fg.subtle">Watermark</Text><Text fontSize="12px">{data.watermark ? "Included" : "None"}</Text></Box>
                </Grid>
              </Stack>
            </Box>

            <Box layerStyle="panel" p="5">
              <Text textStyle="eyebrow" color="fg.subtle" mb="3">Deliver</Text>
              <Stack gap="2">
                <Button
                  asChild={Boolean(selected?.downloadUrl)}
                  colorPalette="accent"
                  disabled={!selected?.downloadUrl}
                  w="full"
                >
                  {selected?.downloadUrl ? (
                    <a href={selected.downloadUrl} download={`narriflow-${selected.aspectRatio.replace(":", "x")}.mp4`}>
                      <Download size={14} /> Download {selected.aspectRatio} · {formatBytes(selected.sizeBytes)}
                    </a>
                  ) : (
                    <><Download size={14} /> Download when ready</>
                  )}
                </Button>
                <Button variant="outline" w="full" disabled={!hasReady || action === "share"} onClick={() => void createShareLink()}>
                  {action === "share" ? <Spinner size="xs" /> : <Link2 size={14} />}
                  Create 7-day private link
                </Button>
                <Button asChild variant="outline" w="full" disabled={!hasReady}>
                  <Link href={`/projects/${data.projectId}?tab=publish`}><ExternalLink size={14} /> Publish to social</Link>
                </Button>
                {hasFailed ? (
                  <Button variant="outline" w="full" disabled={action === "retry"} onClick={() => void retry()}>
                    {action === "retry" ? <Spinner size="xs" /> : <RefreshCw size={14} />} Retry failed variants
                  </Button>
                ) : null}
              </Stack>

              {shareUrl ? (
                <Box mt="4" p="3" bg="bg.muted" borderWidth="1px" borderColor="border" borderRadius="l1">
                  <Flex align="center" gap="2" mb="2"><ShieldCheck size={13} /><Text fontSize="12px" fontWeight="600">Private link copied</Text></Flex>
                  <Text fontSize="11px" color="fg.muted" wordBreak="break-all">{shareUrl}</Text>
                  <Flex gap="2" mt="3">
                    <Button size="xs" variant="outline" onClick={() => void copyShareLink()}><Copy size={12} /> Copy again</Button>
                    <Button size="xs" variant="ghost" disabled={action === "revoke"} onClick={() => void revokeLinks()}>Revoke all</Button>
                  </Flex>
                </Box>
              ) : null}
              {actionError ? (
                <Flex mt="3" gap="2" color="danger.fg" role="alert"><AlertTriangle size={13} /><Text fontSize="11px">{actionError}</Text></Flex>
              ) : null}
            </Box>

            <Box layerStyle="well" p="4">
              <Flex gap="3" align="flex-start">
                <Film size={15} />
                <Box>
                  <Text fontSize="12px" fontWeight="600">Immutable delivery</Text>
                  <Text fontSize="11px" color="fg.muted" mt="0.5">Later edits create a new version. This export and its links never silently change.</Text>
                </Box>
              </Flex>
            </Box>
          </Stack>
        </Grid>
      </Box>
    </Box>
  );
}
