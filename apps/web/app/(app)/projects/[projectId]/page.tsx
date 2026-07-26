import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@narriflow/ui/components/button";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { requireCurrentAppUser } from "@narriflow/auth";
import {
  analyticsService,
  clipService,
  dubbingService,
  MAX_INGEST_RETRY_ATTEMPTS,
  projectService,
  presignDownloadUrl,
  socialOAuthService,
  socialService,
} from "@narriflow/services";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  LEGACY_DEFAULT_CAPTION_PRESET_ID,
  LINK_PROVIDERS,
  captionPresetIdSchema,
  userErrorMessage,
} from "@narriflow/validators";
import { ProjectEvents } from "./project-events";
import {
  queueTranscriptionFormAction,
  regenerateClipsFormAction,
} from "../actions";
import { DeleteProjectButton } from "../_components/delete-project-button";
import { TranscriptPanel } from "./transcript-panel";
import { ClipsPanel } from "./clips-panel";
import { ContentSuitePanel } from "./content-suite-panel";
import { AnalyticsPanel } from "./analytics-panel";
import { DubbingPanel } from "./dubbing-panel";
import { SocialSchedulingPanel } from "./social-scheduling-panel";
import { RenderClipsButton, RetryIngestButton } from "./render-clips-button";
import { AdvancedClipSettings } from "./advanced-clip-settings";
import { STATUS_CONFIG } from "../_lib/status";
import { extractYoutubeId, youtubeThumbnailUrl } from "../_lib/youtube";
import { gradientForId } from "../_lib/gradient";
import { formatDate, formatDuration } from "@/lib/format";
import {
  deriveProjectPipelineStates,
  type PipelineStepState,
} from "@/lib/project-state";
import { Stack, Box, Text, Flex, Tabs } from "@chakra-ui/react";
import { AlertTriangle, Check, ChevronRight, Film, Info, Link2 } from "lucide-react";

type StepState = PipelineStepState;

const STEP_COLORS: Record<
  StepState,
  { node: string; index: string; label: string }
> = {
  done: { node: "success.solid", index: "success.fg", label: "fg.muted" },
  active: { node: "accent.solid", index: "accent.fg", label: "accent.fg" },
  failed: { node: "danger.solid", index: "danger.fg", label: "danger.fg" },
  todo: { node: "border.emphasized", index: "fg.subtle", label: "fg.subtle" },
};

const STEP_STATE_WORD: Record<StepState, string | null> = {
  done: null,
  active: "running",
  failed: "failed",
  todo: null,
};

/**
 * Drawn pipeline stepper — 18px numbered nodes (check circles once done),
 * 11px labels beside them, hairline connectors between steps. State is
 * never hue alone: done carries a check glyph and active/failed carry a
 * mono state word.
 */
function PipelineStepper({
  steps,
}: {
  steps: Array<{ label: string; state: StepState }>;
}) {
  return (
    <Flex
      as="ol"
      align="center"
      w="full"
      aria-label="Pipeline progress"
      listStyleType="none"
      m="0"
      p="0"
      rowGap="2.5"
      columnGap="0"
      wrap="wrap"
    >
      {steps.map((step, index) => {
        const colors = STEP_COLORS[step.state];
        const stateWord = STEP_STATE_WORD[step.state];
        const isLast = index === steps.length - 1;
        return (
          <Flex
            key={step.label}
            as="li"
            align="center"
            flex={isLast ? "0 0 auto" : "1 1 auto"}
            minW="0"
          >
            <Flex align="center" gap="2" flexShrink={0}>
              <Flex
                w="18px"
                h="18px"
                align="center"
                justify="center"
                borderRadius="full"
                borderWidth="1.5px"
                borderColor={colors.node}
                bg={step.state === "done" ? "success.subtle" : "transparent"}
                flexShrink={0}
              >
                {step.state === "done" ? (
                  <Box asChild color="success.fg" aria-label="complete">
                    <Check size={10} strokeWidth={3} />
                  </Box>
                ) : (
                  <Text
                    textStyle="data"
                    fontSize="10px"
                    lineHeight="1"
                    color={colors.index}
                  >
                    {index + 1}
                  </Text>
                )}
              </Flex>
              <Text
                fontSize="11px"
                fontWeight="500"
                lineHeight="1.2"
                color={colors.label}
              >
                {step.label}
              </Text>
              {stateWord && (
                <Text
                  textStyle="data"
                  fontSize="10px"
                  lineHeight="1.2"
                  color={colors.label}
                >
                  · {stateWord}
                </Text>
              )}
            </Flex>
            {!isLast && (
              <Box flex="1" h="1px" bg="border" mx="3" minW="12px" />
            )}
          </Flex>
        );
      })}
    </Flex>
  );
}

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

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const appUser = await requireCurrentAppUser();
  const { projectId } = await params;
  const snapshot = await projectService.getProjectSnapshot(appUser.id, projectId);

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
    pricingTier,
  ] = await Promise.all([
    projectService.getTranscriptSnapshot(appUser.id, projectId),
    clipService.listClips(appUser.id, projectId),
    projectService.getLatestContentPack(projectId),
    analyticsService.getProjectAnalytics(appUser.id, projectId),
    socialService.listProjectPosts(appUser.id, projectId),
    socialOAuthService.listAccounts(appUser.id),
    dubbingService.listProjectDubs(appUser.id, projectId),
    projectService.getWorkflowHistory(appUser.id, projectId),
    projectService.getUserPricingTier(appUser.id),
  ]);

  let sourceVideoUrl: string | null = null;
  if (
    snapshot.project.sourceType !== "youtube" &&
    snapshot.project.sourceStorageKey
  ) {
    try {
      sourceVideoUrl = await presignDownloadUrl({
        key: snapshot.project.sourceStorageKey,
        expiresIn: 3600,
      });
    } catch {
      // Non-fatal — clip cards will show "not available" state
    }
  }

  const isIngestReady = snapshot.project.ingestStatus === "ready";
  const isIngestFailed = snapshot.project.ingestStatus === "failed";
  const ingestAttemptsExhausted =
    snapshot.ingestAttemptCount >= MAX_INGEST_RETRY_ATTEMPTS;
  // Ingest only ever reaches "ready" once sourceStorageKey is set, so a null
  // key here means the source was reclaimed after retention (see
  // purgeExpiredProjectSources), not a broken upload.
  const isSourceExpired = isIngestReady && !snapshot.project.sourceStorageKey;
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
  const isRendering = renderVariants.some(
    (render) => render.status === "pending" || render.status === "rendering",
  );
  const hasAnyRendered = renderVariants.some((render) => render.hasAsset);
  const hasRenderableClips = clips.some((clip) => clip.status !== "rejected");

  const steps: Array<{ label: string; state: StepState }> = [
    {
      label: "Ingest",
      state:
        snapshot.project.ingestStatus === "ready"
          ? "done"
          : snapshot.project.ingestStatus === "failed"
            ? "failed"
            : "active",
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
    },
    {
      label: "Detect",
      state: pipelineStates.detect,
    },
    {
      label: "Render",
      state: pipelineStates.render,
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

  return (
    <Stack gap="8" maxW="1080px" mx="auto" w="full">
      {/* Breadcrumb + header — one unit, tight internal rhythm */}
      <Stack gap="3">
        <Flex
          align="center"
          gap="1.5"
          fontSize="xs"
          color="fg.muted"
          animation="fade-up"
          animationFillMode="backwards"
        >
          <Link href="/projects">
            <Text
              as="span"
              color="fg"
              textDecoration="underline"
              textDecorationColor="border.emphasized"
              textUnderlineOffset="3px"
              transition="text-decoration-color 120ms ease"
              _hover={{ textDecorationColor: "fg" }}
            >
              Projects
            </Text>
          </Link>
          <ChevronRight size={13} aria-hidden />
          <Text color="fg.muted" fontWeight="500" truncate>
            {snapshot.project.title}
          </Text>
        </Flex>

        <Box animation="fade-up" animationFillMode="backwards" style={{ animationDelay: "60ms" }}>
          <PageHeader
            eyebrow="Project"
            title={snapshot.project.title}
            meta={
              <>
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
                <Text textStyle="data" fontSize="xs" color="fg.muted">
                  {formatDate(snapshot.project.createdAt)}
                </Text>
              </>
            }
            actions={
              <DeleteProjectButton
                projectId={projectId}
                projectTitle={snapshot.project.title}
                variant="button"
              />
            }
          />
        </Box>
      </Stack>

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
          <PipelineStepper steps={steps} />
          {isSourceExpired && (
            <Flex align="center" gap="2" color="fg.muted">
              <Info size={13} aria-hidden />
              <Text fontSize="xs">
                The original source was cleared after retention to save storage. Existing clips and renders are unaffected.
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
              {isIngestFailed && (
                <RetryIngestButton
                  projectId={projectId}
                  disabled={ingestAttemptsExhausted}
                  limitReachedMessage={`Retry limit reached (${snapshot.ingestAttemptCount}/${MAX_INGEST_RETRY_ATTEMPTS}). Start a new upload, or contact support.`}
                />
              )}
            </Stack>
          )}
        </Stack>
      </Flex>

      {/* Workspace tabs */}
      <Tabs.Root
        defaultValue="clips"
        variant="line"
        size="sm"
        colorPalette="accent"
        w="full"
        minW="0"
        maxW="full"
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "180ms" }}
      >
        <Tabs.List
          w="full"
          minW="0"
          maxW="full"
          overflowX="auto"
          overflowY="hidden"
          css={{
            scrollbarWidth: "thin",
            scrollbarColor: "var(--chakra-colors-border-emphasized) transparent",
            "&::-webkit-scrollbar": { height: "4px" },
            "&::-webkit-scrollbar-thumb": {
              background: "var(--chakra-colors-border-emphasized)",
              borderRadius: "full",
            },
            "--indicator-thickness": "2px",
          }}
        >
          <Tabs.Trigger
            value="clips"
            color="fg.muted"
            flexShrink={0}
            whiteSpace="nowrap"
            _selected={{ color: "fg" }}
          >
            Clips
            {clips.length > 0 && (
              <Box
                as="span"
                ms="1.5"
                px="1"
                borderWidth="1px"
                borderColor="border"
                borderRadius="l1"
                textStyle="data"
                fontSize="10px"
                lineHeight="1.5"
                color="fg.muted"
              >
                {clips.length}
              </Box>
            )}
          </Tabs.Trigger>
          <Tabs.Trigger
            value="transcript"
            color="fg.muted"
            flexShrink={0}
            whiteSpace="nowrap"
            _selected={{ color: "fg" }}
          >
            Transcript
          </Tabs.Trigger>
          <Tabs.Trigger
            value="repurpose"
            color="fg.muted"
            flexShrink={0}
            whiteSpace="nowrap"
            _selected={{ color: "fg" }}
          >
            Repurpose
          </Tabs.Trigger>
          <Tabs.Trigger
            value="dubbing"
            color="fg.muted"
            flexShrink={0}
            whiteSpace="nowrap"
            _selected={{ color: "fg" }}
          >
            Dubbing
          </Tabs.Trigger>
          <Tabs.Trigger
            value="publish"
            color="fg.muted"
            flexShrink={0}
            whiteSpace="nowrap"
            _selected={{ color: "fg" }}
          >
            Publish
          </Tabs.Trigger>
          <Tabs.Trigger
            value="analytics"
            color="fg.muted"
            flexShrink={0}
            whiteSpace="nowrap"
            _selected={{ color: "fg" }}
          >
            Analytics
          </Tabs.Trigger>
          <Tabs.Trigger
            value="activity"
            color="fg.muted"
            flexShrink={0}
            whiteSpace="nowrap"
            _selected={{ color: "fg" }}
          >
            Activity
          </Tabs.Trigger>
        </Tabs.List>

        {/* CLIPS — pipeline actions + clip grid */}
        <Tabs.Content value="clips" pt="6">
          {!transcriptReady ? (
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
                  </Box>
                  <Button
                    disabled={!isIngestReady || transcriptInFlight}
                    type="submit"
                    size="sm"
                    flexShrink={0}
                  >
                    {transcriptInFlight ? "Transcribing…" : "Start transcription"}
                  </Button>
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
                  </Box>
                  <Button type="submit" size="sm" flexShrink={0} disabled={detectionInFlight}>
                    {detectionInFlight ? "Detecting…" : "Detect clips"}
                  </Button>
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
              <Flex align="center" gap="2" wrap="wrap">
                {hasRenderableClips && (
                  <RenderClipsButton
                    projectId={projectId}
                    disabled={isRendering}
                    buttonLabel={
                      isRendering
                        ? "Rendering…"
                        : hasAnyRendered
                          ? "Re-render clips"
                          : "Render clips"
                    }
                  />
                )}
                <form action={regenerateClipsFormAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                  <Flex align="center" gap="2" wrap="wrap">
                    <Button type="submit" size="sm" variant="outline">
                      Regenerate clips
                    </Button>
                    <AdvancedClipSettings
                      {...advancedSettingsProps}
                      sourceLanguageEditable={false}
                      defaultSourceLanguageCode={snapshot.project.languageCode}
                      compact
                    />
                  </Flex>
                </form>
              </Flex>
              {pricingTier === "free" && hasRenderableClips && (
                <Text fontSize="xs" color="fg.muted">
                  Free plan renders are 720p and watermarked.{" "}
                  <Link href="/settings/billing">
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
              <ClipsPanel
                clips={clips}
                sourceVideoUrl={sourceVideoUrl}
                sourceType={snapshot.project.sourceType}
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
            in ProjectEvents drives router.refresh() for the whole workspace. */}
        <Tabs.Content value="activity" pt="6">
          <ProjectEvents
            projectId={projectId}
            initialSeq={snapshot.lastSeq}
            initialEvents={workflowHistory}
          />
        </Tabs.Content>
      </Tabs.Root>
    </Stack>
  );
}
