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
  BookmarkPlus,
  Download,
  ImagePlus,
  Library,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Spinner, toaster } from "@narriflow/ui";
import type { StudioVisualAsset } from "../studio-shell";
import { useStudio } from "../studio-shell";
import { createGeneratedImagesBrowserApi } from "./generated-images-browser";

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

interface GeneratedImageUsageSummary {
  policy: "trial_metered" | "metered";
  dailyLimit: number;
  reserved: number;
  finalized: number;
  remaining: number;
  trial: { enabled: boolean; consumed: boolean } | null;
}

const STYLES: Array<{ id: Style; label: string }> = [
  { id: "editorial", label: "Editorial" },
  { id: "cinematic", label: "Cinematic" },
  { id: "photoreal", label: "Photoreal" },
  { id: "illustration", label: "Illustration" },
];

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

function generatedMediaErrorCopy(code: string | null | undefined, fallback: string) {
  const copy: Record<string, string> = {
    generated_media_trial_limit_reached: "Your image trial has already been used.",
    generated_media_daily_limit_reached: "Your workspace has reached today's image limit.",
    generated_media_concurrency_limit_reached: "Too many images are already being generated. Try again when one finishes.",
    generated_media_entitlement_required: "Image generation is not enabled for this workspace.",
    generated_media_retry_exhausted: "The image service could not complete this frame after several attempts.",
    generated_media_rejected: "This prompt could not be generated. Edit it and try again.",
    program_write_disabled: "New image generation is temporarily paused.",
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
  } = useStudio();
  const [cueIndex, setCueIndex] = useState(0);
  const cue = clipInfo.brollCues[cueIndex] ?? null;
  const browserApi = useMemo(() => createGeneratedImagesBrowserApi(clipInfo.projectId), [clipInfo.projectId]);
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
      const response = await browserApi.create({
          projectId: clipInfo.projectId,
          clipId: clipInfo.id,
          idempotencyKey: crypto.randomUUID(),
          prompt: composedPrompt,
          promptOrigin: origin,
          aspectRatio: requestedAspectRatio,
          style,
          sourceStartSec: origin === "transcript_selection" ? transcriptSelectionRange?.startSec ?? null : null,
          sourceEndSec: origin === "transcript_selection" ? transcriptSelectionRange?.endSec ?? null : null,
          sourceCueAtSec: origin === "broll_cue" ? cue?.atSec ?? null : null,
      });
      const payload = await response.json() as GeneratedJob & { error?: string; message?: string };
      if (!response.ok) throw new Error(generatedMediaErrorCopy(payload.error, "Image generation could not start"));
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
      motion: { entrance: "fade", exit: "fade" },
      templateSnapshot: null,
    });
    toaster.create({ type: "success", title: "Scene inserted", description: "A four-second image scene was added at the playhead." });
  };

  const saveToBrand = async (asset: NonNullable<GeneratedJob["resultAsset"]>) => {
    if (!brandProfileId) return;
    const response = await fetch(`/api/brand-profiles/${brandProfileId}/membership`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "asset", resourceId: asset.id, role: "image", position: 0 }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      setError(generatedMediaErrorCopy(payload.error, "Could not save this frame to the Brand Profile"));
      return;
    }
    setError(null);
    toaster.create({ type: "success", title: "Saved to Brand Profile" });
  };

  const deleteAsset = async (job: GeneratedJob) => {
    if (!job.resultAsset) return;
    const response = await browserApi.deleteResult(job.id);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      setError(generatedMediaErrorCopy(payload.error, "Could not delete this frame"));
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

  const unavailableCopy = generatedImagesCapability.reason === "rollout_disabled"
    ? "Image generation is currently in a controlled rollout. Existing jobs and assets remain available below."
    : generatedImagesCapability.reason === "trial_disabled"
      ? "The free image trial is not enabled for this workspace."
      : "Image generation is not enabled for this workspace plan yet.";

  return (
    <Stack gap="0" h="100%" overflowY="auto">
      <Stack gap="12px" p="12px" borderBottomWidth="1px" borderColor="studio.border">
        <Flex align="center" justify="space-between">
          <Box>
            <Text textStyle="eyebrow" color="studio.fgMuted">GENERATE STILL</Text>
            <Text fontSize="12px" color="studio.fg">Production image model · Deployment managed</Text>
          </Box>
          <Text fontFamily="mono" fontSize="10px" color="studio.fgMuted">
            {usage ? `${usage.remaining}/${usage.dailyLimit} remaining` : "Usage loading"}
          </Text>
        </Flex>

        {!generatedImagesCapability.available ? (
          <Box layerStyle="well" p="10px" borderLeftWidth="3px" borderLeftColor="studio.accent">
            <Text fontSize="11px" color="studio.fg">New generation is unavailable</Text>
            <Text mt="3px" fontSize="10px" color="studio.fgMuted">{unavailableCopy}</Text>
          </Box>
        ) : null}

        <Flex gap="5px">
          {([
            { id: "transcript_selection", label: "Selection", disabled: !selectionContext },
            { id: "broll_cue", label: "B-roll cue", disabled: !cue },
            { id: "manual", label: "Manual", disabled: false },
          ] as const).map((item) => (
            <Button key={item.id} size="xs" flex="1" variant="outline" borderColor={origin === item.id ? "studio.accent" : "studio.border"} bg={origin === item.id ? "studio.raised" : "transparent"} disabled={item.disabled || !generatedImagesCapability.available} onClick={() => setOrigin(item.id)}>
              {item.label}
            </Button>
          ))}
        </Flex>

        {derivedContext && contextIncluded ? (
          <Box layerStyle="well" p="9px" borderLeftWidth="3px" borderLeftColor="studio.accent">
            <Flex justify="space-between" gap="8px" align="start">
              <Box minW="0">
                <Text textStyle="eyebrow" color="studio.fgMuted">CONTEXT</Text>
                <Text mt="3px" fontSize="11px" lineClamp="3" color="studio.fgMuted">{derivedContext}</Text>
              </Box>
              <Button size="2xs" variant="ghost" disabled={!generatedImagesCapability.available} onClick={() => setContextIncluded(false)}>Remove</Button>
            </Flex>
          </Box>
        ) : derivedContext ? (
          <Button size="xs" variant="outline" onClick={() => setContextIncluded(true)}>Restore derived context</Button>
        ) : null}

        {origin === "broll_cue" && clipInfo.brollCues.length > 1 ? (
          <Stack gap="5px">
            <Text textStyle="eyebrow" color="studio.fgMuted">B-ROLL CUE</Text>
            {clipInfo.brollCues.map((item, index) => (
              <Button key={`${item.atSec}:${item.query}`} size="xs" variant="outline" justifyContent="start" borderColor={cueIndex === index ? "studio.accent" : "studio.border"} disabled={!generatedImagesCapability.available} onClick={() => setCueIndex(index)}>
                <Text fontFamily="mono" fontSize="9px">{item.atSec.toFixed(1)}s</Text>
                <Text lineClamp="1">{item.query}</Text>
              </Button>
            ))}
          </Stack>
        ) : null}

        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the frame—subject, setting, light, camera…"
          minH="82px"
          resize="vertical"
          fontSize="12px"
          bg="studio.subtle"
          borderColor="studio.border"
          disabled={!generatedImagesCapability.available}
        />

        <SimpleGrid columns={2} gap="5px">
          {STYLES.map((item) => (
            <Button key={item.id} size="xs" variant="outline" borderColor={style === item.id ? "studio.accent" : "studio.border"} bg={style === item.id ? "studio.raised" : "transparent"} disabled={!generatedImagesCapability.available} onClick={() => setStyle(item.id)}>
              {item.label}
            </Button>
          ))}
        </SimpleGrid>

        <SimpleGrid columns={3} gap="5px">
          {(["9:16", "16:9", "1:1"] as const).map((value) => (
            <Button key={value} size="xs" variant="outline" borderColor={requestedAspectRatio === value ? "studio.accent" : "studio.border"} bg={requestedAspectRatio === value ? "studio.raised" : "transparent"} disabled={!generatedImagesCapability.available} onClick={() => setRequestedAspectRatio(value)}>
              {value}
            </Button>
          ))}
        </SimpleGrid>

        {limitExhausted ? <Text fontSize="11px" color="studio.fgMuted">Your workspace has used its available images for this period.</Text> : null}
        {error ? <Text fontSize="11px" color="danger.fg">{error}</Text> : null}
        <Button size="sm" colorPalette="accent" onClick={() => void generate()} disabled={!generatedImagesCapability.available || limitExhausted || submitting || (!prompt.trim() && !contextIncluded)}>
          {submitting ? <Spinner size="xs" /> : <Sparkles size={14} />}
          Generate {requestedAspectRatio}
        </Button>
      </Stack>

      <Stack gap="10px" p="12px">
        <Flex align="center" justify="space-between">
          <Text textStyle="eyebrow" color="studio.fgMuted">GENERATED MEDIA</Text>
          <Button size="2xs" variant="ghost" aria-label="Refresh generated images" onClick={() => void refresh()}><RefreshCw size={12} /></Button>
        </Flex>

        {loading ? <Flex py="24px" justify="center"><Spinner /></Flex> : null}
        {pending.map((job) => (
          <Flex key={job.id} layerStyle="well" minH="74px" p="10px" align="center" gap="10px">
            <Flex w="44px" h="54px" align="center" justify="center" bg="studio.canvas" borderWidth="1px" borderColor="studio.border"><Spinner size="xs" /></Flex>
            <Box minW="0" flex="1">
              <Text fontSize="11px" color="studio.fg">{jobStatusCopy(job)}</Text>
              <Text mt="2px" fontFamily="mono" fontSize="9px" color="studio.fgMuted">{job.style.toUpperCase()} · {job.aspectRatio}</Text>
              <Text mt="4px" fontSize="10px" lineClamp="2" color="studio.fgMuted">Safe to leave Studio</Text>
            </Box>
            <Button size="2xs" variant="ghost" onClick={() => void cancel(job)}>Cancel</Button>
          </Flex>
        ))}

        {reconciliation.map((job) => (
          <Flex key={job.id} layerStyle="well" p="9px" align="center" justify="space-between" gap="8px" borderLeftWidth="3px" borderLeftColor="studio.accent">
            <Box minW="0">
              <Text fontSize="11px" color="studio.fg">Needs review</Text>
              <Text mt="2px" fontSize="10px" color="studio.fgMuted" lineClamp="2">The provider outcome is uncertain. Usage remains reserved until reconciliation.</Text>
            </Box>
          </Flex>
        ))}

        {terminal.map((job) => (
          <Flex key={job.id} layerStyle="well" p="9px" align="center" justify="space-between" gap="8px" borderLeftWidth="3px" borderLeftColor={job.status === "rejected" ? "danger.fg" : "studio.borderStrong"}>
            <Box minW="0">
              <Text fontSize="11px" color="studio.fg">{jobStatusCopy(job)}</Text>
              <Text mt="2px" fontSize="10px" color="studio.fgMuted" lineClamp="2">{generatedMediaErrorCopy(job.errorCode, "No image was created or charged.")}</Text>
            </Box>
            <Button size="2xs" variant="ghost" onClick={() => setJobs((current) => current.filter((candidate) => candidate.id !== job.id))}>Dismiss</Button>
          </Flex>
        ))}

        {completed.length === 0 && pending.length === 0 && reconciliation.length === 0 && terminal.length === 0 && !loading ? (
          <Flex direction="column" align="center" py="28px" px="18px" textAlign="center" color="studio.fgMuted">
            <ImagePlus size={22} />
            <Text mt="8px" fontSize="11px">Generated frames stay here until you insert, save, download, or delete them.</Text>
          </Flex>
        ) : null}

        <SimpleGrid columns={2} gap="8px">
        {completed.map((job) => {
          const asset = job.resultAsset!;
          const insertionWindow = brollWindowAtPlayhead();
          const selectedBroll = insertionWindow.selected;
          const insertBlocked = editorDocument.studioEdits.visualBroll.some((placement) =>
            placement.startSec < insertionWindow.endSec && insertionWindow.startSec < placement.endSec,
          );
          const usedInDocument = editorDocument.studioEdits.visualBroll.some((placement) => placement.asset.id === asset.id) || editorDocument.sceneBlocks.some((scene) => (scene.content.kind === "image" || scene.content.kind === "video") && scene.content.asset.id === asset.id);
          return (
            <Box key={job.id} borderWidth="1px" borderColor="studio.border" bg="studio.subtle" overflow="hidden">
              <Box aspectRatio={job.aspectRatio === "9:16" ? "9 / 16" : job.aspectRatio === "16:9" ? "16 / 9" : "1"} maxH="190px" bg="studio.canvas" overflow="hidden">
                <img src={asset.accessUrl!} alt={asset.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </Box>
              <Stack gap="7px" p="9px">
                <Flex align="center" justify="space-between" gap="8px">
                  <Text fontSize="11px" lineClamp="1" color="studio.fg">{asset.title}</Text>
                  <Text fontFamily="mono" fontSize="9px" color="studio.fgMuted">{job.style.toUpperCase()}</Text>
                </Flex>
                <Button size="xs" variant="outline" disabled={insertBlocked} title={insertBlocked ? "Move the playhead to a free range or replace the selected B-roll" : "Insert a four-second B-roll placement"} onClick={() => insertBroll(asset)}><ImagePlus size={12} />Insert at playhead</Button>
                <Button size="xs" variant="outline" disabled={!selectedBroll} title={selectedBroll ? "Replace the B-roll under the playhead" : "Move the playhead over a B-roll placement"} onClick={() => replaceBroll(asset)}><ImagePlus size={12} />Replace selected B-roll</Button>
                <Button size="xs" variant="outline" onClick={() => insertScene(asset)}><Library size={12} />Insert image scene</Button>
                <SimpleGrid columns={3} gap="5px">
                  <Button size="xs" variant="ghost" aria-label="Save to Brand Profile" title="Save to Brand Profile" disabled={!brandProfileId} onClick={() => void saveToBrand(asset)}><BookmarkPlus size={13} /></Button>
                  <Button asChild size="xs" variant="ghost"><a href={asset.accessUrl!} download aria-label="Download generated image" title="Download"><Download size={13} /></a></Button>
                  <Button size="xs" variant="ghost" colorPalette="danger" aria-label="Delete generated image" disabled={usedInDocument} title={usedInDocument ? "Remove this frame from the timeline before deleting it" : "Delete"} onClick={() => void deleteAsset(job)}><Trash2 size={13} /></Button>
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
