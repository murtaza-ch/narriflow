import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@narriflow/ui/components/button";
import { ActionSubmitButton } from "@narriflow/ui/components/action-submit-button";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { requireWorkspaceProject } from "@/lib/workspace";
import {
  analyticsService,
  clipService,
  dubbingService,
  hasFeature,
  isQuotaBlockedMidFlight,
  MAX_INGEST_RETRY_ATTEMPTS,
  presignDownloadUrl,
  projectService,
  socialOAuthService,
  socialService,
} from "@narriflow/services";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  LEGACY_DEFAULT_CAPTION_PRESET_ID,
  LINK_PROVIDERS,
  captionPresetIdSchema,
  defaultAspectRatioSchema,
  processingMinutesFromSeconds,
  userErrorMessage,
} from "@narriflow/validators";
import { ProjectEvents } from "./project-events";
import { ProjectEventsProvider } from "./project-events-provider";
import { PipelineStepper } from "./pipeline-stepper";
import { ingestRecoveryAction } from "@/lib/project-state";
import { ProjectTabs, TabCountBadge } from "./project-tabs";
import { ProcessingPanel } from "./processing-panel";
import {
  queueTranscriptionFormAction,
  regenerateClipsFormAction,
} from "../actions";
import { DeleteProjectButton } from "../_components/delete-project-button";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { TranscriptPanel } from "./transcript-panel";
import { ClipsPanel } from "./clips-panel";
import { ContentSuitePanel } from "./content-suite-panel";
import { AnalyticsPanel } from "./analytics-panel";
import { DubbingPanel } from "./dubbing-panel";
import { SocialSchedulingPanel } from "./social-scheduling-panel";
import { RetryIngestButton } from "./render-clips-button";
import { AdvancedClipSettings } from "./advanced-clip-settings";
import { STATUS_CONFIG } from "../_lib/status";
import { extractYoutubeId, youtubeThumbnailUrl } from "../_lib/youtube";
import { gradientForId } from "../_lib/gradient";
import { formatDate, formatDuration } from "@/lib/format";
import {
  deriveProjectPipelineStates,
  type PipelineStepView,
  type ProcessingStageInput,
} from "@/lib/project-state";
import { Stack, Box, Text, Flex, Tabs } from "@chakra-ui/react";
import { AlertTriangle, ArrowLeft, Film, Info, Link2 } from "lucide-react";

function linkProviderLabel(sourceProvider: string | null | undefined): string {
  return LINK_PROVIDERS.find((p) => p.id === sourceProvider)?.label ?? "Link";
}
function SourceThumb({
  projectId,
  title,
  sourceType,
  sourceInput,
  sourceMediaUrl,
}: {
  projectId: string;
  title: string;
  sourceType: string;
  sourceInput: string | null;
  sourceMediaUrl: string;
}) {
  const youtubeId =
    sourceType === "youtube"
      ? extractYoutubeId(sourceInput, sourceMediaUrl)
      : null;

  if (youtubeId) {
    return (
      <Image
        src={youtubeThumbnailUrl(youtubeId, "hq")}
        alt={title}
        fill
        sizes="256px"
        style={{ objectFit: "cover" }}
      />
    );
  }

  const gradient = gradientForId(projectId);
  return (
    <Flex
      w="full"
      h="full"
      align="center"
      justify="center"
      style={{
        background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
      }}
    >
      <Box color="whiteAlpha.700">
        {sourceType === "link" ? (
          <Link2 size={20} aria-hidden />
        ) : (
          <Film size={20} aria-hidden />
        )}
      </Box>
    </Flex>
  );
}

/**
 * Inline reason a plan gate is blocking generation, shown beside the action it
 * disables. Without this the server action's QuotaExceededError /
 * UploadTooLongError could only be expressed as a redirect, which read as the
 * button doing nothing.
 */
// PlanLimitNotice moved to app/(app)/_components/plan-limit-notice.tsx so the
// upload pre-flight can reuse it.

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const appUser = await requireWorkspaceProject(projectId);
  const snapshot = await projectService.getProjectSnapshot(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

  if (!snapshot.project) {
    notFound();
  }

  const [
    transcript,
    clips,
    latestContentPack,
    analytics,
    socialPosts,
    socialAccounts,
    dubs,
    workflowHistory,
    usage,
  ] = await Promise.all([
    projectService.getTranscriptSnapshot(appUser.id, projectId),
    clipService.listClips(appUser.id, projectId),
    projectService.getLatestContentPack(projectId),
    analyticsService.getProjectAnalytics(appUser.id, projectId),
    socialService.listProjectPosts(appUser.id, projectId),
    socialOAuthService.listAccounts(appUser.id, appUser.workspaceId),
    dubbingService.listProjectDubs(appUser.id, projectId),
    projectService.getWorkflowHistory(appUser.id, projectId),
    projectService.getUsageSummary(appUser.id),
  ]);
  const pricingTier = usage.tier;
  // vizard-parity Phase C export options: whether this owner's plan can
  // render at 1080p, via the shared entitlement helper — never a raw
  // `pricingTier === "free"` check — so the render popover's resolution
  // picker degrades exactly the way the worker's render-time gate does.
  const can1080pExport = hasFeature(pricingTier, "export.1080p");

  const isIngestReady = snapshot.project.ingestStatus === "ready";
  const isIngestFailed = snapshot.project.ingestStatus === "failed";
  const ingestAttemptsExhausted =
    snapshot.ingestAttemptCount >= MAX_INGEST_RETRY_ATTEMPTS;
  const ingestRetryLimitMessage = `Retry limit reached (${snapshot.ingestAttemptCount}/${MAX_INGEST_RETRY_ATTEMPTS}). This source keeps failing to import.`;
  // Ingest only ever reaches "ready" once sourceStorageKey is set, so a null
  // key here means the source was reclaimed after retention (see
  // purgeExpiredProjectSources), not a broken upload.
  const isSourceExpired = isIngestReady && !snapshot.project.sourceStorageKey;
  // Playable source URL for the Trim/Extend dialog's preview pane (same
  // presign the studio uses). Null once the source is purged — the dialog
  // hides the player pane rather than breaking.
  let sourceVideoUrl: string | null = null;
  if (snapshot.project.sourceStorageKey) {
    try {
      sourceVideoUrl = await presignDownloadUrl({
        key: snapshot.project.sourceStorageKey,
        expiresIn: 3600,
      });
    } catch {
      // Non-fatal — the dialog degrades to transcript-only.
    }
  }
  // Same two gates projectService.assertProjectGenerationAllowed enforces, read
  // here so the blocked state is visible before the click instead of only as a
  // thrown QuotaExceededError/UploadTooLongError afterwards.
  const sourceSeconds = snapshot.project.sourceDurationSeconds ?? 0;
  const planLimitMessage =
    sourceSeconds > usage.maxUploadSeconds
      ? `This source is ${processingMinutesFromSeconds(sourceSeconds)} min, over the ${Math.round(
          usage.maxUploadSeconds / 60,
        )}-min per-upload limit on the ${pricingTier} plan.`
      : usage.usedMinutes > usage.limitMinutes
        ? `Monthly processing limit reached on the ${pricingTier} plan (${usage.limitMinutes} min/mo; ${usage.usedMinutes} min used).`
        : null;
  const transcriptReady = transcript?.status === "completed";
  const transcriptInFlight =
    transcript?.status === "queued" || transcript?.status === "processing";
  const captionPresetParsed = captionPresetIdSchema.safeParse(
    latestContentPack?.captionPreset,
  );
  const defaultCaptionPreset =
    captionPresetParsed.success &&
    captionPresetParsed.data !== LEGACY_DEFAULT_CAPTION_PRESET_ID
      ? captionPresetParsed.data
      : BRAND_DEFAULT_CAPTION_PRESET_ID;
  // Raw Prisma column, not the zod-narrowed union — parse it the same way
  // defaultCaptionPreset does above, rather than casting.
  const defaultAspectRatioParsed = defaultAspectRatioSchema.safeParse(
    latestContentPack?.defaultAspectRatio,
  );
  const clipsDefaultAspectRatio = defaultAspectRatioParsed.success
    ? defaultAspectRatioParsed.data
    : "9:16";
  const advancedSettingsProps = {
    sourceDurationSec: snapshot.project.sourceDurationSeconds,
    defaultProcessingStartSec: latestContentPack?.processingStartSec ?? null,
    defaultProcessingEndSec: latestContentPack?.processingEndSec ?? null,
    defaultCaptionPreset,
  };

  // Pipeline derivation from existing workflow/status data.
  const activeRun = snapshot.activeRun;
  const renderVariants = clips.flatMap((clip) => clip.renderVariants);
  const pipelineStates = deriveProjectPipelineStates({
    clipCount: clips.length,
    latestRun: activeRun,
    renderVariants,
    socialPosts,
  });
  const detectionInFlight = pipelineStates.detect === "active";
  const hasAnyRendered = renderVariants.some((render) => render.hasAsset);
  const hasRenderableClips = clips.length > 0;

  // Link-first split (Phase 0/1): the latest pack may still be a draft — a
  // draft must never be treated as an active configuration (never read its
  // mode/autoRenderClips as if generation could be running against it).
  const isDraftPack = latestContentPack?.draft === true;
  const hasCommittedPack = latestContentPack !== null && !isDraftPack;
  const generationMode: "clip" | "caption_only" =
    latestContentPack?.mode === "caption_only" ? "caption_only" : "clip";
  const autoRenderClips = latestContentPack?.autoRenderClips ?? false;

  const ingestInProgress = !isIngestReady && !isIngestFailed;
  const runInFlight =
    activeRun !== null &&
    (activeRun.status === "queued" ||
      activeRun.status === "running" ||
      activeRun.status === "waiting");
  const runFailed = activeRun !== null && activeRun.status === "failed";
  const quotaBlockedMidFlight = isQuotaBlockedMidFlight({
    ingestReady: isIngestReady,
    hasCommittedPack,
    hasAnyRun: activeRun !== null,
    tier: usage.tier,
    usedMinutes: usage.usedMinutes,
  });
  const quotaBlockedMessage = quotaBlockedMidFlight
    ? `Monthly limit reached during processing (${usage.limitMinutes} min/mo; ${usage.usedMinutes} min used) on the ${usage.tier} plan.`
    : null;

  const transcribeStage: ProcessingStageInput =
    activeRun?.stage === "stt"
      ? {
          status: activeRun.status as ProcessingStageInput["status"],
          progress: activeRun.progress,
          errorCode: activeRun.errorCode,
        }
      : transcriptReady
        ? { status: "completed", progress: 100, errorCode: null }
        : transcript?.status === "failed"
          ? { status: "failed", progress: 0, errorCode: transcript.errorCode ?? null }
          : { status: null, progress: 0, errorCode: null };

  const detectStage: ProcessingStageInput =
    activeRun?.stage === "moment_detection"
      ? {
          status: activeRun.status as ProcessingStageInput["status"],
          progress: activeRun.progress,
          errorCode: activeRun.errorCode,
        }
      : clips.length > 0
        ? { status: "completed", progress: 100, errorCode: null }
        : { status: null, progress: 0, errorCode: null };

  // Renders queued by auto-render (or caption-only's mandatory 16:9 render)
  // continue within the SAME WorkflowRun row, so its stage moves on to
  // "clip_rendering" once detection hands off — this is the latest
  // render-stage run's status, not a guess from asset counts.
  const renderStage: ProcessingStageInput =
    activeRun?.stage === "clip_rendering"
      ? {
          status: activeRun.status as ProcessingStageInput["status"],
          progress: activeRun.progress,
          errorCode: activeRun.errorCode,
        }
      : hasAnyRendered
        ? { status: "completed", progress: 100, errorCode: null }
        : { status: null, progress: 0, errorCode: null };

  // Phase 2a — the Clips tab shows the processing panel instead of the
  // Step 01/02 form cards whenever a run is in flight, or ingest is still
  // running/failed with a committed pack, or quota was crossed mid-flight.
  //
  // Mode-aware cutover to the ranked-rows results view (Phase 3):
  // - Plain clip mode (no auto-render): resolves as soon as clips are found
  //   — render is a later, per-clip, user-triggered action that never blocks
  //   results.
  // - Clip mode WITH auto-render, and caption-only (its render is
  //   mandatory): fold a render into the same run, so the panel stays up
  //   until that render *succeeds* — a mid-render or failed render must not
  //   silently flip to results. A render failure keeps the panel showing
  //   its in-panel danger band (the checklist's render node already renders
  //   one) rather than dropping the user into an empty/incomplete results view.
  const renderGatesProcessingPanel = generationMode === "caption_only" || autoRenderClips;
  const renderStageSucceeded =
    renderStage.status === "completed" || renderStage.status === "partial";
  const showProcessingPanel =
    hasCommittedPack &&
    (clips.length === 0
      ? ingestInProgress || isIngestFailed || runInFlight || runFailed || quotaBlockedMidFlight
      : renderGatesProcessingPanel && !renderStageSucceeded);

  const steps: PipelineStepView[] = [
    {
      label: "Ingest",
      state:
        snapshot.project.ingestStatus === "ready"
          ? "done"
          : snapshot.project.ingestStatus === "failed"
            ? "failed"
            : "active",
      status: snapshot.project.ingestStatus,
    },
    {
      label: "Transcribe",
      state: transcriptReady
        ? "done"
        : transcriptInFlight
          ? "active"
          : transcript?.status === "failed"
            ? "failed"
            : "todo",
      status: activeRun?.stage === "stt" ? activeRun.status : transcript?.status,
    },
    {
      label: "Detect",
      state: pipelineStates.detect,
      status:
        activeRun?.stage === "moment_detection" ? activeRun.status : null,
    },
    {
      label: "Render",
      state: pipelineStates.render,
      status:
        activeRun?.stage === "clip_rendering"
          ? activeRun.status
          : renderVariants.some((variant) => variant.status === "rendering")
            ? "running"
            : renderVariants.some((variant) => variant.status === "pending")
              ? "queued"
              : null,
    },
    {
      label: "Publish",
      state: pipelineStates.publish,
    },
  ];

  const durationSec = snapshot.project.sourceDurationSeconds;

  // Same status vocabulary as the projects list: interim ingest stages
  // (uploading/downloading/normalizing) read as processing with stage labels.
  const ingestBadge =
    STATUS_CONFIG[snapshot.project.ingestStatus] ?? STATUS_CONFIG.queued!;

  // 1240px stays. Widening this to 1600px on large screens was tried and
  // reverted: once the prose blocks in ClipRow are capped to a readable
  // measure, a clip row's natural content is only ~900px wide, so the extra
  // width did not let anything breathe — it stretched the row and opened an
  // 800px dead band between the transcript and the right-hand score. The page
  // felt empty because prose was running to 1000px per line, not because the
  // container was too narrow.
  return (
    <Stack gap="8" maxW="1240px" mx="auto" w="full">
      <ProjectEventsProvider
        projectId={projectId}
        initialSeq={snapshot.lastSeq}
        initialEvents={workflowHistory}
      >
      {/* Vizard-style workspace bar: the sidebar is suppressed on open
          projects (see AppChrome), so this row is the navigation — back
          arrow + title + status meta left, destructive action right. */}
      <Flex
        align="center"
        gap="3"
        wrap="wrap"
        animation="fade-up"
        animationFillMode="backwards"
      >
        <Link href="/projects" aria-label="Back to projects">
          <Flex
            align="center"
            justify="center"
            w="30px"
            h="30px"
            borderRadius="l1"
            color="fg.muted"
            transition="color 120ms ease, background 120ms ease"
            _hover={{ color: "fg", bg: "bg.subtle" }}
          >
            <ArrowLeft size={16} aria-hidden />
          </Flex>
        </Link>
        <Text
          as="h1"
          textStyle="title"
          fontSize="lg"
          color="fg"
          truncate
          minW="0"
          flexShrink={1}
        >
          {snapshot.project.title}
        </Text>
        <Flex align="center" gap="3" flexShrink={0}>
          <StatusBadge status={ingestBadge.status} label={ingestBadge.label} />
          {typeof durationSec === "number" && durationSec > 0 && (
            <Text textStyle="data" fontSize="xs" color="fg.timecode">
              {formatDuration(durationSec)}
            </Text>
          )}
          <Text textStyle="eyebrow" color="fg.subtle">
            {snapshot.project.sourceType === "link"
              ? linkProviderLabel(snapshot.project.sourceProvider)
              : snapshot.project.sourceType}
          </Text>
          <Text
            textStyle="data"
            fontSize="xs"
            color="fg.muted"
            display={{ base: "none", md: "block" }}
          >
            {formatDate(snapshot.project.createdAt)}
          </Text>
        </Flex>
        <Box flex="1" />
        <DeleteProjectButton
          projectId={projectId}
          projectTitle={snapshot.project.title}
          variant="button"
        />
      </Flex>

      <Flex
        gap="5"
        align={{ base: "stretch", md: "center" }}
        direction={{ base: "column", md: "row" }}
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "120ms" }}
      >
        <MediaWell
          ratio={16 / 9}
          w={{ base: "full", md: "232px" }}
          flexShrink={0}
          timecode={
            typeof durationSec === "number" && durationSec > 0
              ? formatDuration(durationSec)
              : undefined
          }
        >
          <SourceThumb
            projectId={projectId}
            title={snapshot.project.title}
            sourceType={snapshot.project.sourceType}
            sourceInput={snapshot.project.sourceInput}
            sourceMediaUrl={snapshot.project.sourceMediaUrl}
          />
        </MediaWell>

        <Stack flex="1" minW="0" gap="3">
          <PipelineStepper
            steps={steps}
            workflowRunId={activeRun?.workflowRunId ?? null}
          />
          {isSourceExpired && (
            <Flex align="center" gap="2" color="fg.muted">
              <Info size={13} aria-hidden />
              <Text fontSize="xs">
                The original source was cleared after retention to save storage. Existing clips and renders are unaffected.
              </Text>
            </Flex>
          )}
          {activeRun?.status === "partial" && (
            <Flex align="center" gap="2" color="warning.fg">
              <AlertTriangle size={14} aria-hidden />
              <Text fontSize="sm">
                Some outputs failed, but successful clips remain ready to use.
                Retry only the failed outputs from their rows.
              </Text>
            </Flex>
          )}
          {snapshot.project.ingestErrorCode && (
            <Stack gap="2">
              <Flex align="center" gap="2" color="danger.fg">
                <AlertTriangle size={14} aria-hidden />
                <Text fontSize="sm">
                  {userErrorMessage(snapshot.project.ingestErrorCode)}
                </Text>
              </Flex>
              {isIngestFailed &&
                ingestRecoveryAction(snapshot.project.ingestErrorCode) ===
                  "retry" && (
                <RetryIngestButton
                  projectId={projectId}
                  disabled={ingestAttemptsExhausted}
                  limitReachedMessage={`Retry limit reached (${snapshot.ingestAttemptCount}/${MAX_INGEST_RETRY_ATTEMPTS}). This source keeps failing to import.`}
                />
              )}
              {isIngestFailed &&
                ingestRecoveryAction(snapshot.project.ingestErrorCode) ===
                  "new_upload" && (
                  <Button size="xs" variant="outline" asChild alignSelf="flex-start">
                    <Link href="/upload">Upload video instead</Link>
                  </Button>
                )}
            </Stack>
          )}
        </Stack>
      </Flex>

      {/* Workspace tabs — URL-driven (?tab=); SSE stream shared via
          ProjectEventsProvider so the Clips-tab processing checklist and the
          Activity tab consume the same EventSource (no second connection). */}
      <ProjectTabs clipsCountBadge={<TabCountBadge count={clips.length} />}>
        {/* CLIPS — processing panel while a run/ingest is in flight, ranked
            results once clips exist, legacy step cards otherwise. */}
        <Tabs.Content value="clips" pt="6">
          {isDraftPack ? (
            <Flex
              align="center"
              justify="space-between"
              gap="3"
              wrap="wrap"
              p="4"
              borderWidth="1px"
              borderColor="border"
              borderRadius="l2"
            >
              <Flex align="center" gap="2">
                <Info size={14} aria-hidden />
                <Text fontSize="sm" color="fg.muted">
                  This project's setup isn't finished yet.
                </Text>
              </Flex>
              <Button size="sm" variant="outline" asChild>
                <Link href={`/upload?project=${projectId}`}>Finish setup</Link>
              </Button>
            </Flex>
          ) : showProcessingPanel ? (
            <ProcessingPanel
              projectId={projectId}
              mediaWell={
                <MediaWell
                  ratio={16 / 9}
                  timecode={
                    typeof durationSec === "number" && durationSec > 0
                      ? formatDuration(durationSec)
                      : undefined
                  }
                >
                  <SourceThumb
                    projectId={projectId}
                    title={snapshot.project.title}
                    sourceType={snapshot.project.sourceType}
                    sourceInput={snapshot.project.sourceInput}
                    sourceMediaUrl={snapshot.project.sourceMediaUrl}
                  />
                </MediaWell>
              }
              projectTitle={snapshot.project.title}
              durationSec={durationSec}
              notifyOnComplete={snapshot.project.notifyOnComplete}
              ingestStatus={snapshot.project.ingestStatus}
              ingestErrorCode={snapshot.project.ingestErrorCode}
              ingestAttemptsExhausted={ingestAttemptsExhausted}
              ingestRetryLimitMessage={ingestRetryLimitMessage}
              transcribe={transcribeStage}
              detect={detectStage}
              render={renderStage}
              mode={generationMode}
              autoRenderClips={autoRenderClips}
              clipCount={clips.length}
              hasAnyRendered={hasAnyRendered}
              quotaBlockedMessage={quotaBlockedMessage}
              advancedSettingsProps={advancedSettingsProps}
              defaultSourceLanguageCode={snapshot.project.languageCode}
            />
          ) : !transcriptReady ? (
            <form action={queueTranscriptionFormAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <Stack gap="4">
                <Flex align="flex-start" justify="space-between" gap="4" wrap="wrap">
                  <Box>
                    <Text textStyle="eyebrow" color="fg.subtle" mb="1">
                      Step 01
                    </Text>
                    <Text fontSize="md" textStyle="title" color="fg">
                      AI Transcription
                    </Text>
                    <Text fontSize="sm" color="fg.muted" mt="0.5">
                      Queue transcription with the current clip preferences.
                    </Text>
                    {!isIngestReady && (
                      <Flex align="center" gap="1.5" mt="1.5" color="warning.fg">
                        <AlertTriangle size={13} aria-hidden />
                        <Text fontSize="xs">
                          Transcription is disabled until ingest is ready.
                        </Text>
                      </Flex>
                    )}
                    <PlanLimitNotice message={planLimitMessage} />
                  </Box>
                  <ActionSubmitButton
                    pendingLabel="Starting…"
                    disabled={
                      !isIngestReady ||
                      transcriptInFlight ||
                      planLimitMessage !== null
                    }
                    type="submit"
                    size="sm"
                    flexShrink={0}
                  >
                    {transcriptInFlight ? "Transcribing…" : "Start transcription"}
                  </ActionSubmitButton>
                </Flex>
                <AdvancedClipSettings
                  {...advancedSettingsProps}
                  sourceLanguageEditable={true}
                  defaultSourceLanguageCode={snapshot.project.languageCode}
                />
              </Stack>
            </form>
          ) : clips.length === 0 ? (
            <form action={regenerateClipsFormAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <Stack gap="4">
                <Flex align="flex-start" justify="space-between" gap="4" wrap="wrap">
                  <Box>
                    <Text textStyle="eyebrow" color="fg.subtle" mb="1">
                      Step 02
                    </Text>
                    <Text fontSize="md" textStyle="title" color="fg">
                      AI Clip Detection
                    </Text>
                    <Text fontSize="sm" color="fg.muted" mt="0.5">
                      Detect clip-worthy moments and score them for virality.
                    </Text>
                    <PlanLimitNotice message={planLimitMessage} />
                  </Box>
                  <ActionSubmitButton
                    pendingLabel="Starting…"
                    size="sm"
                    flexShrink={0}
                    disabled={detectionInFlight || planLimitMessage !== null}
                  >
                    {detectionInFlight ? "Detecting…" : "Detect clips"}
                  </ActionSubmitButton>
                </Flex>
                <AdvancedClipSettings
                  {...advancedSettingsProps}
                  sourceLanguageEditable={false}
                  defaultSourceLanguageCode={snapshot.project.languageCode}
                />
              </Stack>
            </form>
          ) : (
            <Stack gap="5">
              {/* No "Regenerate clips" affordance once a clip set exists —
                  market-aligned with Vizard's one-shot clipping model. Failed
                  and zero-clip runs still expose Retry/Re-run detection in
                  the processing panel, and the first detection is Step 02. */}
              {pricingTier === "free" && hasRenderableClips && (
                <Text fontSize="xs" color="fg.muted">
                  Free plan renders are 720p and watermarked.{" "}
                  <Link href="/settings/subscription">
                    <Text
                      as="span"
                      color="fg"
                      textDecoration="underline"
                      textDecorationColor="border.emphasized"
                      textUnderlineOffset="3px"
                      transition="text-decoration-color 120ms ease"
                      _hover={{ textDecorationColor: "fg" }}
                    >
                      Upgrade
                    </Text>
                  </Link>{" "}
                  for 1080p, no watermark.
                </Text>
              )}
              {/* Ranked-row results (Phase 3). The view's single solid
                  ultramarine button — "Render selected" — lives in this
                  panel's toolbar; there is no standalone render-all button
                  here anymore. */}
              <ClipsPanel
                clips={clips}
                projectId={projectId}
                mode={generationMode}
                isFreeTier={pricingTier === "free"}
                can1080pExport={can1080pExport}
                defaultAspectRatio={clipsDefaultAspectRatio}
                sourceVideoUrl={sourceVideoUrl}
              />
            </Stack>
          )}
        </Tabs.Content>

        {/* TRANSCRIPT */}
        <Tabs.Content value="transcript" pt="6">
          <TranscriptPanel projectId={projectId} transcript={transcript} />
        </Tabs.Content>

        {/* REPURPOSE */}
        <Tabs.Content value="repurpose" pt="6">
          {transcriptReady ? (
            <ContentSuitePanel
              projectId={projectId}
              transcriptReady={transcriptReady}
            />
          ) : (
            <EmptyState
              title="Transcript required"
              description="Repurposing turns the finished transcript into a blog post, X thread, LinkedIn post, show notes and quote cards. Complete transcription first."
            />
          )}
        </Tabs.Content>

        {/* DUBBING */}
        <Tabs.Content value="dubbing" pt="6">
          <DubbingPanel projectId={projectId} clips={clips} dubs={dubs} />
        </Tabs.Content>

        {/* PUBLISH */}
        <Tabs.Content value="publish" pt="6">
          <SocialSchedulingPanel
            projectId={projectId}
            clips={clips}
            posts={socialPosts}
            accounts={socialAccounts}
          />
        </Tabs.Content>

        {/* ANALYTICS */}
        <Tabs.Content value="analytics" pt="6">
          <AnalyticsPanel analytics={analytics} />
        </Tabs.Content>

        {/* ACTIVITY — keep mounted regardless of active tab: the SSE stream
            (owned by ProjectEventsProvider above) drives router.refresh()
            for the whole workspace. */}
        <Tabs.Content value="activity" pt="6">
          <ProjectEvents />
        </Tabs.Content>
      </ProjectTabs>
      </ProjectEventsProvider>
    </Stack>
  );
}
