"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import {
  PANEL_PX,
  PanelEmpty,
  PanelSegmented,
  SectionLabel,
  chipProps,
  softButtonProps,
  softFieldProps,
} from "./panel-ui";
import {
  BookmarkPlus,
  Download,
  ImagePlus,
  Library,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import type { BrandClient } from "@narriflow/api-client/brand";
import type { InferResponseType } from "hono/client";
import { STUDIO_EDIT_LIMITS } from "@narriflow/validators";
import type { StudioVisualAsset } from "../studio-shell";
import { upgradePromptFromFailure, type BrowserRequestFailure } from "@/lib/authenticated-request-browser";
import { useUpgrade } from "@/app/(app)/_components/upgrade";
import { useStudio } from "../studio-shell";
import { StudioLockGem } from "../studio-lock-gem";
import { generatedImagesExhaustedCopy, generatedImagesUpgradePrompt } from "../studio-upgrade";
import { useAudioApi } from "./audio-library";
import { useStudioApi } from "../use-studio-api";
import { assetInUseCopy, createGeneratedImagesBrowserApi } from "./generated-images-browser";

type GeneratedImageUsageSummary = NonNullable<
  InferResponseType<BrandClient["projects"][":projectId"]["generated-media"]["jobs"]["$get"], 200>["usage"]
>;

type PromptOrigin = "transcript_selection" | "broll_cue" | "manual";
type Style = "editorial" | "cinematic" | "photoreal" | "illustration";

interface GeneratedJob {
  id: string;
  promptOrigin: PromptOrigin;
  aspectRatio: "9:16" | "16:9" | "1:1";
  style: Style;
  title: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "rejected" | "cancelled";
  errorCode: string | null;
  outcomeUnknown: boolean;
  resultAsset: null | {
    id: string;
    title: string;
    kind: "image";
    contentType: "image/png" | "image/jpeg" | "image/webp";
    sizeBytes: number;
    width: number;
    height: number;
    durationSec: null;
    fingerprint: string;
    provenance: "generated";
    accessUrl: string | null;
    createdAt: string;
  };
  createdAt: string;
}

const STYLES: Array<{ id: Style; label: string }> = [
  { id: "editorial", label: "Editorial" },
  { id: "cinematic", label: "Cinematic" },
  { id: "photoreal", label: "Photoreal" },
  { id: "illustration", label: "Illustration" },
];

// Little ratio glyphs inside the switch, so the choice reads as a shape too.
const RATIOS = [
  { id: "9:16", w: "9px", h: "14px" },
  { id: "16:9", w: "14px", h: "9px" },
  { id: "1:1", w: "11px", h: "11px" },
] as const;

function generatedAssetForStudio(asset: NonNullable<GeneratedJob["resultAsset"]>): StudioVisualAsset {
  return {
    id: asset.id,
    title: asset.title,
    kind: "image",
    fingerprint: asset.fingerprint,
    durationSec: null,
    accessUrl: asset.accessUrl,
    missing: !asset.accessUrl,
    insertable: Boolean(asset.accessUrl),
  };
}

function jobStatusCopy(job: GeneratedJob) {
  if (job.status === "queued") return "Queued";
  if (job.status === "running") return "Creating";
  if (job.status === "waiting") return "Reconciling";
  if (job.status === "rejected") return "Prompt rejected";
  if (job.status === "cancelled") return "Cancelled";
  if (job.status === "failed") return "Generation failed";
  return "Ready";
}

/** `studioEditsSchema.visualBroll`'s cap; past it the document can't save. */
export const MAX_VISUAL_BROLL = STUDIO_EDIT_LIMITS.visualBroll;

function generatedMediaErrorCopy(code: string | null | undefined, fallback: string) {
  const copy: Record<string, string> = {
    generated_media_concurrency_limit_reached: "Too many images are already being generated. Try again when one finishes.",
    generated_media_retry_exhausted: "The image service could not complete this frame after several attempts.",
    generated_media_rejected: "This prompt could not be generated. Edit it and try again.",
  };
  return code ? copy[code] ?? fallback : fallback;
}

export function GeneratedImagesPanel() {
  const {
    aspectRatio,
    brandProfileId,
    clipInfo,
		compositeToBaseEdited,
    duration,
		editedTimeMap,
    editorDocument,
    insertSceneBlock,
    playbackClock,
    registerVisualAsset,
    setBrollUrl,
    setStudioEdits,
    transcriptSelectionRange,
    unregisterVisualAsset,
    utterances,
    generatedImagesCapability,
    sceneWriteCapabilities,
    upgradePrompts,
  } = useStudio("aspectRatio", "brandProfileId", "clipInfo", "compositeToBaseEdited", "duration", "editedTimeMap", "editorDocument", "insertSceneBlock", "playbackClock", "registerVisualAsset", "setBrollUrl", "setStudioEdits", "transcriptSelectionRange", "unregisterVisualAsset", "utterances", "generatedImagesCapability", "sceneWriteCapabilities", "upgradePrompts");
  const { currentTier, openUpgrade } = useUpgrade();
  const [cueIndex, setCueIndex] = useState(0);
  const cue = clipInfo.brollCues[cueIndex] ?? null;
  const brandApi = useAudioApi();
  const studioApi = useStudioApi();
  const studioRuntime = studioApi?.runtime;
  // One image intent per panel: Generate pressed again with the same inputs reuses its key until accepted.
  const imageIntent = useMemo(() => studioRuntime?.createIntent<Record<string, unknown>>() ?? null, [studioRuntime]);
  const browserApi = useMemo(
    () => (brandApi && imageIntent ? createGeneratedImagesBrowserApi(clipInfo.projectId, brandApi, imageIntent) : null),
    [brandApi, imageIntent, clipInfo.projectId],
  );
  const selectionContext = useMemo(() => {
    if (!transcriptSelectionRange) return "";
    return utterances
      .filter((utterance) =>
        utterance.words.some((word) =>
          word.startSec < transcriptSelectionRange.endSec &&
          transcriptSelectionRange.startSec < word.endSec,
        ),
      )
      .map((utterance) => utterance.text)
      .join(" ")
      .trim();
  }, [transcriptSelectionRange, utterances]);
  const [origin, setOrigin] = useState<PromptOrigin>(selectionContext ? "transcript_selection" : cue ? "broll_cue" : "manual");
  const derivedContext = origin === "transcript_selection"
    ? selectionContext
    : origin === "broll_cue"
      ? cue?.query ?? ""
      : "";
  const [contextIncluded, setContextIncluded] = useState(Boolean(derivedContext));
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState<Style>("editorial");
  const [requestedAspectRatio, setRequestedAspectRatio] = useState<"9:16" | "16:9" | "1:1">(
    aspectRatio === "4:5" ? "9:16" : aspectRatio,
  );
  const [jobs, setJobs] = useState<GeneratedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<GeneratedImageUsageSummary | null>(null);
  const refreshInFlight = useRef(false);

  useEffect(() => setContextIncluded(Boolean(derivedContext)), [derivedContext]);
  useEffect(() => {
    if (origin === "transcript_selection" && !selectionContext) setOrigin(cue ? "broll_cue" : "manual");
    if (origin === "broll_cue" && !cue) setOrigin(selectionContext ? "transcript_selection" : "manual");
  }, [cue, origin, selectionContext]);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      if (!browserApi) return;
      const response = await browserApi.list(clipInfo.id);
      const payload = await response.json() as { jobs?: GeneratedJob[]; usage?: GeneratedImageUsageSummary; error?: string; message?: string };
      if (!response.ok) throw new Error(generatedMediaErrorCopy(payload.error, "Could not load generated images"));
      const next = payload.jobs ?? [];
      setUsage(payload.usage ?? null);
      setJobs(next);
      next.forEach((job) => {
        if (job.resultAsset) registerVisualAsset(generatedAssetForStudio(job.resultAsset));
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load generated images");
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
    }
  }, [browserApi, clipInfo.id, registerVisualAsset]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActiveJob = jobs.some((job) =>
    ["queued", "running"].includes(job.status) || (job.status === "waiting" && !job.outcomeUnknown),
  );
  useEffect(() => {
    if (!hasActiveJob) return;
    const interval = window.setInterval(() => void refresh(), 2_500);
    return () => window.clearInterval(interval);
  }, [hasActiveJob, refresh]);

  const generate = async () => {
    const authored = prompt.trim();
    const context = contextIncluded ? derivedContext.trim() : "";
    if (!authored && !context) {
      setError("Describe the frame, or include transcript context.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const composedPrompt = [authored, context ? `Spoken context: ${context}` : ""]
        .filter(Boolean)
        .join("\n\n");
      if (!browserApi) throw new Error("Image generation could not start");
      const response = await browserApi.create({
          projectId: clipInfo.projectId,
          clipId: clipInfo.id,
          prompt: composedPrompt,
          promptOrigin: origin,
          aspectRatio: requestedAspectRatio,
          style,
          sourceStartSec: origin === "transcript_selection" ? transcriptSelectionRange?.startSec ?? null : null,
          sourceEndSec: origin === "transcript_selection" ? transcriptSelectionRange?.endSec ?? null : null,
          sourceCueAtSec: origin === "broll_cue" ? cue?.atSec ?? null : null,
      });
      const payload = await response.json() as GeneratedJob & BrowserRequestFailure;
      if (!response.ok) {
        const upgrade = upgradePromptFromFailure(payload);
        if (upgrade) openUpgrade(upgrade);
        throw new Error(generatedMediaErrorCopy(payload.error, payload.message ?? "Image generation could not start"));
      }
      setJobs((current) => [payload, ...current.filter((job) => job.id !== payload.id)]);
      setPrompt("");
      toaster.create({ type: "success", title: "Frame queued", description: "You can leave Studio—this job will keep running." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Image generation could not start");
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (job: GeneratedJob) => {
    if (!browserApi) return;
    const response = await browserApi.cancel(job.id);
    const payload = await response.json().catch(() => null) as GeneratedJob | { error?: string; message?: string } | null;
    if (!response.ok || !payload || !("id" in payload)) {
      setError(payload && "error" in payload ? generatedMediaErrorCopy(payload.error, "Could not cancel generation") : "Could not cancel generation");
      return;
    }
    setJobs((current) => current.map((candidate) => candidate.id === job.id ? payload : candidate));
  };

  const brollWindowAtPlayhead = () => {
    const baseDurationSec = editedTimeMap.editedDurationSec;
    const startSec = Math.max(0, Math.min(compositeToBaseEdited(playbackClock.getSnapshot()), Math.max(0, baseDurationSec - 0.5)));
    const endSec = Math.min(baseDurationSec, startSec + 4);
    const selected = editorDocument.studioEdits.visualBroll.find((placement) =>
      placement.startSec <= startSec && startSec < placement.endSec,
    );
    return { startSec, endSec, selected };
  };

  const insertBroll = (asset: NonNullable<GeneratedJob["resultAsset"]>) => {
    const { startSec, endSec } = brollWindowAtPlayhead();
    const intersects = editorDocument.studioEdits.visualBroll.some((placement) =>
      placement.startSec < endSec && startSec < placement.endSec,
    );
    if (intersects) {
      toaster.create({ type: "warning", title: "B-roll already covers this range", description: "Replace the selected B-roll or move the playhead to a free range." });
      return;
    }
    if (editorDocument.studioEdits.visualBroll.length >= MAX_VISUAL_BROLL) {
      toaster.create({ type: "warning", title: `A clip holds up to ${MAX_VISUAL_BROLL} B-roll placements`, description: "Remove one from the timeline, or replace the selected B-roll." });
      return;
    }
    setStudioEdits((current) => ({
      ...current,
      visualBroll: [...current.visualBroll, {
            id: crypto.randomUUID(),
            asset: { kind: "visual_asset" as const, id: asset.id, fingerprint: asset.fingerprint },
            startSec,
            endSec,
            fit: "cover" as const,
          }].sort((left, right) => left.startSec - right.startSec),
    }));
    setBrollUrl(null);
    registerVisualAsset(generatedAssetForStudio(asset));
    toaster.create({ type: "success", title: "B-roll inserted", description: `${startSec.toFixed(1)}–${endSec.toFixed(1)} seconds` });
  };

  const replaceBroll = (asset: NonNullable<GeneratedJob["resultAsset"]>) => {
    const { selected } = brollWindowAtPlayhead();
    if (!selected) return;
    setStudioEdits((current) => ({
      ...current,
      visualBroll: current.visualBroll.map((placement) => placement.id === selected.id
        ? { ...placement, asset: { kind: "visual_asset" as const, id: asset.id, fingerprint: asset.fingerprint } }
        : placement),
    }));
    setBrollUrl(null);
    registerVisualAsset(generatedAssetForStudio(asset));
    toaster.create({ type: "success", title: "Selected B-roll replaced" });
  };

  const insertScene = (asset: NonNullable<GeneratedJob["resultAsset"]>) => {
    const anchorSec = Math.max(0, Math.min(playbackClock.getSnapshot(), duration));
    registerVisualAsset(generatedAssetForStudio(asset));
    insertSceneBlock({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      anchorSec,
      durationSec: 4,
      content: {
        kind: "image",
        asset: { kind: "visual_asset", id: asset.id, fingerprint: asset.fingerprint },
        fit: "cover",
        backgroundColor: "#0A0B0E",
      },
      motion: { entrance: "fade", exit: "fade", durationSec: 0.5 },
      templateSnapshot: null,
    });
    toaster.create({ type: "success", title: "Scene inserted", description: "A four-second image scene was added at the playhead." });
  };

  const saveToBrand = async (asset: NonNullable<GeneratedJob["resultAsset"]>) => {
    if (!brandProfileId || !browserApi) return;
    const response = await browserApi.saveToBrandProfile(brandProfileId, {
      kind: "asset",
      resourceId: asset.id,
      role: "image",
      position: 0,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as BrowserRequestFailure & { error?: string };
      const upgrade = upgradePromptFromFailure(payload);
      if (upgrade) openUpgrade(upgrade);
      setError(generatedMediaErrorCopy(payload.error, payload.message ?? "Could not save this frame to the Brand Profile"));
      return;
    }
    setError(null);
    toaster.create({ type: "success", title: "Saved to Brand Profile" });
  };

  const deleteAsset = async (job: GeneratedJob) => {
    if (!job.resultAsset) return;
    if (!browserApi) return;
    const response = await browserApi.deleteResult(job.id);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as BrowserRequestFailure & { error?: string };
      setError(assetInUseCopy(payload) ?? generatedMediaErrorCopy(payload.error, "Could not delete this frame"));
      return;
    }
    setError(null);
    setJobs((current) => current.filter((candidate) => candidate.id !== job.id));
    unregisterVisualAsset(job.resultAsset.id);
  };

  const completed = jobs.filter((job) => job.resultAsset?.accessUrl);
  const pending = jobs.filter((job) =>
    !job.outcomeUnknown && job.status !== "completed" && !["failed", "rejected", "cancelled"].includes(job.status),
  );
  const reconciliation = jobs.filter((job) => job.outcomeUnknown);
  const terminal = jobs.filter((job) => ["failed", "rejected", "cancelled"].includes(job.status));
  const limitExhausted = usage?.remaining === 0;
  // Same playhead window for every frame, so one visible hint covers them all.
  const insertionWindow = brollWindowAtPlayhead();
  const insertBlocked = editorDocument.studioEdits.visualBroll.some((placement) =>
    placement.startSec < insertionWindow.endSec && insertionWindow.startSec < placement.endSec,
  );
  const selectedBroll = insertionWindow.selected;
  const sceneLock = sceneWriteCapabilities.images ? null : upgradePrompts.scenes;

  const unavailableCopy = generatedImagesCapability.reason === "provider_unavailable"
    ? "Image generation is temporarily unavailable. Existing jobs and images remain available below."
    : "Image generation is not included in this workspace plan.";

  return (
    <Stack gap="0" h="100%" overflowY="auto">
      <Stack gap="4" px={PANEL_PX} pt="4" pb="5">
        <Flex align="center" justify="space-between">
          <Text fontSize="13px" fontWeight="500" color="studio.fgMuted">Generate a still</Text>
          <Text px="2.5" lineHeight="22px" borderRadius="full" bg="studio.subtle" fontSize="11.5px" color="studio.fgMuted" fontVariantNumeric="tabular-nums">
            {usage ? `${usage.remaining}/${usage.limit} left` : "Usage loading"}
          </Text>
        </Flex>

        {!generatedImagesCapability.available ? (
          <Box bg="studio.subtle" borderRadius="12px" p="3.5">
            <Text fontSize="13px" color="studio.fg" fontWeight="500">New generation is unavailable</Text>
            <Text mt="1" fontSize="12px" lineHeight="1.5" color="studio.fgMuted">{unavailableCopy}</Text>
          </Box>
        ) : null}

        <PanelSegmented
          ariaLabel="Prompt source"
          value={origin}
          onChange={setOrigin}
          items={[
            { value: "transcript_selection", label: "Selection", disabled: !selectionContext || !generatedImagesCapability.available, title: selectionContext ? undefined : "Select transcript text first" },
            { value: "broll_cue", label: "B-roll cue", disabled: !cue || !generatedImagesCapability.available, title: cue ? undefined : "No B-roll cue for this clip" },
            { value: "manual", label: "Manual", disabled: !generatedImagesCapability.available },
          ]}
        />

        {derivedContext && contextIncluded ? (
          <Flex justify="space-between" gap="3" align="start" bg="studio.subtle" borderRadius="12px" p="3.5">
            <Box minW="0">
              <Text fontSize="12px" fontWeight="500" color="studio.fgMuted">Context</Text>
              <Text mt="1" fontSize="13px" lineClamp="3" color="studio.fg">{derivedContext}</Text>
            </Box>
            <Button size="2xs" {...softButtonProps} disabled={!generatedImagesCapability.available} onClick={() => setContextIncluded(false)}>Remove</Button>
          </Flex>
        ) : derivedContext ? (
          <Button size="sm" {...softButtonProps} onClick={() => setContextIncluded(true)}>Restore derived context</Button>
        ) : null}

        {origin === "broll_cue" && clipInfo.brollCues.length > 1 ? (
          <Box>
            <SectionLabel>B-roll cue</SectionLabel>
            <Stack gap="1.5">
              {clipInfo.brollCues.map((item, index) => (
                <Button key={`${item.atSec}:${item.query}`} variant="ghost" justifyContent="start" gap="3" {...chipProps(cueIndex === index)} h="36px" disabled={!generatedImagesCapability.available} onClick={() => setCueIndex(index)}>
                  <Text fontFamily="mono" fontSize="11.5px" fontVariantNumeric="tabular-nums">{item.atSec.toFixed(1)}s</Text>
                  <Text lineClamp="1">{item.query}</Text>
                </Button>
              ))}
            </Stack>
          </Box>
        ) : null}

        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the frame—subject, setting, light, camera…"
          minH="88px"
          resize="vertical"
          fontSize="14px"
          {...softFieldProps}
          disabled={!generatedImagesCapability.available}
        />

        <Box>
          <SectionLabel>Style</SectionLabel>
          <SimpleGrid columns={4} gap="1.5" role="group" aria-label="Style">
            {STYLES.map((item) => (
              <Button key={item.id} variant="ghost" aria-pressed={style === item.id} {...chipProps(style === item.id)} px="0" fontSize="12px" disabled={!generatedImagesCapability.available} onClick={() => setStyle(item.id)}>
                {item.label}
              </Button>
            ))}
          </SimpleGrid>
        </Box>

        <Box>
          <SectionLabel>Ratio</SectionLabel>
          <PanelSegmented
            ariaLabel="Aspect ratio"
            value={requestedAspectRatio}
            onChange={setRequestedAspectRatio}
            items={RATIOS.map((item) => ({
              value: item.id,
              disabled: !generatedImagesCapability.available,
              label: (
                <>
                  <Box w={item.w} h={item.h} borderRadius="2px" bg="currentColor" opacity={0.55} aria-hidden />
                  {item.id}
                </>
              ),
            }))}
          />
        </Box>

        {generatedImagesCapability.available && limitExhausted && usage ? (() => {
          // Only a larger allowance on a higher tier is offered; a concurrency limit just waits.
          // An unavailable provider is never an upgrade reason.
          const prompt = generatedImagesUpgradePrompt(currentTier, usage.monthUsed);
          const exhausted = generatedImagesExhaustedCopy(usage, prompt);
          return (
            <Flex align="center" justify="space-between" gap="3" wrap="wrap">
              <Text fontSize="12px" color="studio.fgMuted">{exhausted.message}</Text>
              {exhausted.upgrade && prompt?.tier ? (
                <Button size="2xs" {...softButtonProps} aria-haspopup="dialog" onClick={() => openUpgrade(prompt)}>
                  More images<StudioLockGem tier={prompt.tier} size={12} />
                </Button>
              ) : null}
            </Flex>
          );
        })() : null}
        {error ? <Text fontSize="12px" color="danger.fg">{error}</Text> : null}
        <Button h="44px" borderRadius="10px" fontSize="14px" fontWeight="500" colorPalette="brand" _disabled={{ bg: "studio.raised", color: "studio.fgSubtle", opacity: 1, cursor: "not-allowed" }} onClick={() => void generate()} disabled={!generatedImagesCapability.available || limitExhausted || submitting || (!prompt.trim() && !contextIncluded)}>
          {submitting ? <Spinner size="xs" /> : <Sparkles size={14} />}
          Generate {requestedAspectRatio}
        </Button>
      </Stack>

      <Stack gap="3" px={PANEL_PX} pt="2" pb="5">
        <SectionLabel
          action={<Button size="2xs" variant="ghost" aria-label="Refresh generated images" onClick={() => void refresh()}><RefreshCw size={12} /></Button>}
        >
          Generated media
        </SectionLabel>

        {loading ? <Flex py="24px" justify="center"><Spinner /></Flex> : null}
        {pending.map((job) => (
          <Flex key={job.id} bg="studio.subtle" borderRadius="12px" minH="74px" p="3" align="center" gap="3">
            <Flex w="44px" h="54px" align="center" justify="center" bg="studio.canvas" borderRadius="8px"><Spinner size="xs" /></Flex>
            <Box minW="0" flex="1">
              <Text fontSize="13px" color="studio.fg">{jobStatusCopy(job)}</Text>
              <Text mt="0.5" fontFamily="mono" fontSize="10.5px" color="studio.fgMuted">{job.style.toUpperCase()} · {job.aspectRatio}</Text>
              <Text mt="1" fontSize="12px" lineClamp="2" color="studio.fgMuted">Safe to leave Studio</Text>
            </Box>
            <Button size="2xs" {...softButtonProps} onClick={() => void cancel(job)}>Cancel</Button>
          </Flex>
        ))}

        {reconciliation.map((job) => (
          <Flex key={job.id} bg="studio.subtle" borderRadius="12px" p="3" align="center" justify="space-between" gap="2">
            <Box minW="0">
              <Text fontSize="13px" color="studio.fg">Needs review</Text>
              <Text mt="0.5" fontSize="12px" color="studio.fgMuted" lineClamp="2">The provider outcome is uncertain. Usage remains reserved until reconciliation.</Text>
            </Box>
          </Flex>
        ))}

        {terminal.map((job) => (
          <Flex key={job.id} bg="studio.subtle" borderRadius="12px" p="3" align="center" justify="space-between" gap="2">
            <Box minW="0">
              <Text fontSize="13px" color="studio.fg">{jobStatusCopy(job)}</Text>
              <Text mt="0.5" fontSize="12px" color="studio.fgMuted" lineClamp="2">{generatedMediaErrorCopy(job.errorCode, "No image was created or charged.")}</Text>
            </Box>
            <Button size="2xs" {...softButtonProps} onClick={() => setJobs((current) => current.filter((candidate) => candidate.id !== job.id))}>Dismiss</Button>
          </Flex>
        ))}

        {completed.length === 0 && pending.length === 0 && reconciliation.length === 0 && terminal.length === 0 && !loading ? (
          <PanelEmpty icon={<ImagePlus size={18} />} title="No frames yet">
            Generated frames stay here until you insert, save, download or delete them.
          </PanelEmpty>
        ) : null}

        {completed.length > 0 ? (
          <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.5">
            {insertBlocked
              ? "B-roll already covers the playhead. Replace it, or move the playhead to a free spot to insert."
              : "Insert adds four seconds of B-roll at the playhead. Move the playhead over B-roll to replace it."}
          </Text>
        ) : null}

        <SimpleGrid columns={2} gap="2">
        {completed.map((job) => {
          const asset = job.resultAsset!;
          const usedInDocument = editorDocument.studioEdits.visualBroll.some((placement) => placement.asset.id === asset.id) || editorDocument.sceneBlocks.some((scene) => (scene.content.kind === "image" || scene.content.kind === "video") && scene.content.asset.id === asset.id);
          return (
            <Box key={job.id} bg="studio.subtle" borderRadius="12px" overflow="hidden">
              <Box w="full" aspectRatio={job.aspectRatio === "9:16" ? "9 / 16" : job.aspectRatio === "16:9" ? "16 / 9" : "1"} maxH="190px" bg="studio.canvas" overflow="hidden">
                <img src={asset.accessUrl!} alt={asset.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </Box>
              <Stack gap="1.5" p="2">
                <Flex align="baseline" justify="space-between" gap="2" px="1">
                  <Text fontSize="12px" lineClamp="1" color="studio.fg">{asset.title}</Text>
                  <Text fontFamily="mono" fontSize="10px" color="studio.fgMuted">{job.style.toUpperCase()}</Text>
                </Flex>
                <Button size="xs" {...softButtonProps} disabled={insertBlocked} onClick={() => insertBroll(asset)}><ImagePlus size={12} />Insert at playhead</Button>
                <Button size="xs" {...softButtonProps} disabled={!selectedBroll} onClick={() => replaceBroll(asset)}><ImagePlus size={12} />Replace selected B-roll</Button>
                {sceneLock?.tier ? (
                  <Button size="xs" {...softButtonProps} aria-haspopup="dialog" onClick={() => openUpgrade(sceneLock)}><Library size={12} />Insert image scene<StudioLockGem tier={sceneLock.tier} size={12} /></Button>
                ) : sceneWriteCapabilities.images ? (
                  <Button size="xs" {...softButtonProps} onClick={() => insertScene(asset)}><Library size={12} />Insert image scene</Button>
                ) : null}
                <SimpleGrid columns={brandProfileId ? 3 : 2} gap="1">
                  {brandProfileId ? (
                    <Button size="xs" variant="ghost" aria-label="Save to Brand Profile" title="Save to Brand Profile" onClick={() => void saveToBrand(asset)}><BookmarkPlus size={13} /></Button>
                  ) : null}
                  <Button asChild size="xs" variant="ghost"><a href={asset.accessUrl!} download aria-label="Download generated image" title="Download"><Download size={13} /></a></Button>
                  <Button size="xs" variant="ghost" colorPalette="danger" aria-label="Delete generated image" title="Delete" onClick={() => {
                    if (usedInDocument) toaster.create({ type: "warning", title: "This frame is on the timeline", description: "Remove it from the timeline before deleting it." });
                    else void deleteAsset(job);
                  }}><Trash2 size={13} /></Button>
                </SimpleGrid>
              </Stack>
            </Box>
          );
        })}
        </SimpleGrid>
      </Stack>
    </Stack>
  );
}
