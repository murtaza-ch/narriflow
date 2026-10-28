"use client";

import {
	type ComponentProps,
	type ReactNode,
	useEffect,
	useOptimistic,
	useState,
	useTransition,
} from "react";
import Link from "next/link";
import { Box, Flex, Stack, Text, VisuallyHidden } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { ActionSubmitButton } from "@narriflow/ui/components/action-submit-button";
import { Switch } from "@narriflow/ui/components/switch";
import { deriveProcessingChecklist, userErrorMessage, type PipelineStepState, type ProcessingNode, type ProcessingNodeId, type ProcessingStageInput, type CaptionPresetId } from "@narriflow/validators";
import {
  AlertTriangle,
  AudioLines,
  Check,
  Download,
  Film,
  Flag,
  type LucideIcon,
  RotateCcw,
  ScanSearch,
} from "lucide-react";
import {
  ingestRecoveryAction,
  ingestRecoveryLabel,
  liveIngestStageWord,
  mergeStageWithLiveEvent,
} from "@/lib/project-state";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import type { UpgradePrompt } from "../../_components/upgrade";
import {
  queueTranscriptionFormAction,
  regenerateClipsFormAction,
  setNotifyPreferenceAction,
} from "../actions";
import { AuthenticatedActionForm } from "@/app/_components/authenticated-action-form";
import { authenticatedActionResultMessage } from "@/lib/authenticated-request-browser";
import { RetryIngestButton } from "./render-clips-button";
import { useProjectEvents } from "./project-events-provider";
import { AdvancedClipSettings } from "./advanced-clip-settings";

const STEP_ICONS: Record<ProcessingNodeId, LucideIcon> = {
  import: Download,
  transcribe: AudioLines,
  detect: ScanSearch,
  render: Film,
  done: Flag,
};

const STEP_STATE_WORDS: Record<PipelineStepState, string> = {
  done: "complete",
  active: "in progress",
  failed: "failed",
  todo: "not started",
};

const NODE_COLORS: Record<PipelineStepState, { node: string; mark: string; label: string }> = {
  done: { node: "accent.solid", mark: "accent.contrast", label: "fg" },
  active: { node: "accent.subtle", mark: "accent.fg", label: "fg" },
  failed: { node: "danger.subtle", mark: "danger.fg", label: "danger.fg" },
  todo: { node: "bg.soft", mark: "fg.subtle", label: "fg.subtle" },
};

/** Known progress fills the meter; otherwise the processing shimmer runs. */
function StepMeter({ label, progress }: { label: string; progress: number | null }) {
  return (
    <Box
      role="progressbar"
      aria-label={`${label} progress`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress === null ? undefined : Math.round(progress)}
      h="4px"
      borderRadius="full"
      bg="bg.muted"
      overflow="hidden"
    >
      {progress === null ? (
        <Box
          h="full"
          backgroundImage="linear-gradient(90deg, transparent 20%, {colors.accent.solid} 50%, transparent 80%)"
          backgroundSize="200% 100%"
          animation="shimmer"
        />
      ) : (
        <Box
          h="full"
          w={`${progress}%`}
          bg="accent.solid"
          borderRadius="full"
          transition="width 600ms cubic-bezier(0.22, 1, 0.36, 1)"
        />
      )}
    </Box>
  );
}

// No entrance animation on the card or its steps: the detection settings
// drawer renders in place (its fields belong to the retry form), and a
// transformed ancestor would trap its fixed-position backdrop.
function ChecklistStepper({
  nodes,
  recovery,
}: {
  nodes: ProcessingNode[];
  /** The failed step's own explanation and next action, in place of its bare error message. */
  recovery: Partial<Record<ProcessingNodeId, ReactNode>>;
}) {
  return (
    <Stack as="ol" aria-label="Processing progress" gap="0" listStyleType="none" m="0" p="0">
      {nodes.map((node, index) => {
        const colors = NODE_COLORS[node.state];
        const StepIcon = STEP_ICONS[node.id];
        const isLast = index === nodes.length - 1;
        const failure =
          node.state === "failed"
            ? (recovery[node.id] ??
              (node.errorCode ? <FailureMessage>{userErrorMessage(node.errorCode)}</FailureMessage> : null))
            : null;
        return (
          <Flex
            key={node.id}
            as="li"
            aria-current={node.state === "active" ? "step" : undefined}
            gap="3.5"
            align="stretch"
          >
            <Flex direction="column" align="center" flexShrink={0} aria-hidden="true">
              <Flex
                position="relative"
                w="28px"
                h="28px"
                align="center"
                justify="center"
                borderRadius="full"
                bg={colors.node}
                color={colors.mark}
                transition="background-color 300ms ease, color 300ms ease"
              >
                {node.state === "done" ? (
                  <Check size={14} strokeWidth={3} />
                ) : node.state === "failed" ? (
                  <AlertTriangle size={13} strokeWidth={2.25} />
                ) : (
                  <StepIcon size={14} strokeWidth={2} />
                )}
                {node.state === "active" && (
                  <Box
                    position="absolute"
                    inset="-3px"
                    borderRadius="full"
                    borderWidth="2px"
                    borderColor="transparent"
                    borderTopColor="accent.solid"
                    animation="spin"
                    animationDuration="1.2s"
                  />
                )}
              </Flex>
              {!isLast && (
                <Box
                  w="2px"
                  flex="1"
                  minH="12px"
                  my="1.5"
                  borderRadius="full"
                  bg={node.state === "done" ? "accent.solid" : "bg.muted"}
                  transition="background-color 300ms ease"
                />
              )}
            </Flex>
            <Stack
              gap="2"
              flex="1"
              minW="0"
              mt={node.state === "active" || node.state === "failed" ? "-1.5" : "0"}
              mb={isLast ? "0" : "4"}
              pt={node.state === "active" || node.state === "failed" ? "2.5" : "1"}
              pb={node.state === "active" || node.state === "failed" ? "3" : "0"}
              px={node.state === "active" || node.state === "failed" ? "3.5" : "0"}
              borderRadius="l2"
              bg={node.state === "failed" ? "danger.subtle" : node.state === "active" ? "bg.soft" : "transparent"}
              transition="background-color 300ms ease"
            >
              <Flex align="baseline" justify="space-between" gap="3" wrap="wrap">
                <Text fontSize="14px" fontWeight="500" lineHeight="20px" color={colors.label}>
                  {node.label}
                  <VisuallyHidden>, {STEP_STATE_WORDS[node.state]}</VisuallyHidden>
                </Text>
                {node.detail && (
                  <Text fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
                    {node.detail}
                  </Text>
                )}
              </Flex>
              {node.state === "active" && <StepMeter label={node.label} progress={node.progress} />}
              {failure}
            </Stack>
          </Flex>
        );
      })}
    </Stack>
  );
}

/** One segment per step: done fills, the running step shimmers, a stop shows in danger. */
function RunSegments({ nodes }: { nodes: ProcessingNode[] }) {
  return (
    <Flex gap="1.5" aria-hidden="true">
      {nodes.map((node) => (
        <Box key={node.id} flex="1" h="6px" borderRadius="full" overflow="hidden" bg="bg.muted">
          {node.state === "done" ? (
            <Box h="full" bg="accent.solid" borderRadius="full" />
          ) : node.state === "failed" ? (
            <Box h="full" bg="danger.solid" borderRadius="full" />
          ) : node.state === "active" ? (
            node.progress === null ? (
              <Box
                h="full"
                backgroundImage="linear-gradient(90deg, transparent 20%, {colors.accent.solid} 50%, transparent 80%)"
                backgroundSize="200% 100%"
                animation="shimmer"
              />
            ) : (
              <Box
                h="full"
                bg="accent.solid"
                borderRadius="full"
                transition="width 600ms cubic-bezier(0.22, 1, 0.36, 1)"
                style={{ width: `${Math.max(6, node.progress)}%` }}
              />
            )
          ) : null}
        </Box>
      ))}
    </Flex>
  );
}

function FailureMessage({ children }: { children: ReactNode }) {
  return (
    <Text fontSize="13px" color="fg.muted" maxW="60ch">
      {children}
    </Text>
  );
}

function RetryForm({
  action,
  projectId,
  idempotencyKey,
  label,
  pendingLabel,
  settings,
}: {
  action: ComponentProps<typeof AuthenticatedActionForm>["action"];
  projectId: string;
  idempotencyKey: string;
  label: string;
  pendingLabel: string;
  settings: ReactNode;
}) {
  return (
    <AuthenticatedActionForm action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Flex align="center" gap="2" wrap="wrap" mt="1">
        <ActionSubmitButton pendingLabel={pendingLabel} size="sm">
          <RotateCcw size={16} />
          <Text ms="1">{label}</Text>
        </ActionSubmitButton>
        {settings}
      </Flex>
    </AuthenticatedActionForm>
  );
}

function NotifyToggle({
  projectId,
  initialNotifyOnComplete,
}: {
  projectId: string;
  initialNotifyOnComplete: boolean;
}) {
  const [committedChecked, setCommittedChecked] = useState(initialNotifyOnComplete);
  const [checked, setOptimisticChecked] = useOptimistic(committedChecked);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(next: boolean) {
    setError(null);
    startSaving(async () => {
      setOptimisticChecked(next);
      const result = await setNotifyPreferenceAction(projectId, next);
      if (result.ok) {
        setCommittedChecked(next);
      } else {
        setError(authenticatedActionResultMessage(result, "Could not save this preference."));
      }
    });
  }

  return (
    <Stack gap="1" align="flex-start">
      <Switch checked={checked} onCheckedChange={handleChange} disabled={saving}>
        Email me when clips are ready
      </Switch>
      {error && (
        <Flex align="center" gap="1.5" color="danger.fg">
          <AlertTriangle size={12} aria-hidden />
          <Text fontSize="xs">{error}</Text>
        </Flex>
      )}
    </Stack>
  );
}

export interface ProcessingPanelProps {
  projectId: string;
  mediaWell: ReactNode;
  projectTitle: string;
  notifyOnComplete: boolean;
  ingestStatus: string;
  ingestErrorCode: string | null;
  ingestAttemptsExhausted: boolean;
  /** The latest ingest was a Google Drive Picker import, which only a new pick can recover. */
  ingestFromDrivePicker: boolean;
  /** Pre-formatted "Retry limit reached (N/MAX)…" copy — computed
   *  server-side (page.tsx already imports MAX_INGEST_RETRY_ATTEMPTS from
   *  @narriflow/services; that constant lives in the Prisma-backed
   *  project.service.ts module and must not be imported into this client
   *  bundle). */
  ingestRetryLimitMessage: string;
  transcribe: ProcessingStageInput;
  detect: ProcessingStageInput;
  render: ProcessingStageInput;
  mode: "clip" | "caption_only";
  workflowRunId: string | null;
  quotaBlockedMessage: string | null;
  /** The plan that would clear the quota block; `null` when none does (the top plan). */
  quotaUpgrade: UpgradePrompt | null;
  advancedSettingsProps: {
    sourceDurationSec: number | null;
    sourceFrames?: string[];
    defaultProcessingStartSec: number | null;
    defaultProcessingEndSec: number | null;
    defaultCaptionPreset: CaptionPresetId;
  };
  defaultSourceLanguageCode: string | null;
  /** Role and workspace status allow retries and preferences; otherwise progress is read-only. */
  canEdit: boolean;
}

/**
 * Phase 2a — replaces the Step 01/02 form cards in the Clips tab while a run
 * is in flight, or ingest is still running with a committed pack. Consumes
 * the shared SSE context (ProjectEventsProvider) directly so live progress
 * shows without a second EventSource or extra router.refresh() calls beyond
 * the provider's existing 5s throttle.
 */
export function ProcessingPanel(props: ProcessingPanelProps) {
  const { latestByStage } = useProjectEvents();
  const [regenerateIdempotencyKey, setRegenerateIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [transcribeRetryKey, setTranscribeRetryKey] = useState(() =>
    crypto.randomUUID(),
  );
  const liveDetectionRunId = latestByStage.moment_detection?.workflowRunId;
  const liveTranscriptRunId = latestByStage.stt?.workflowRunId;

  // One key belongs to one admitted run. Rotate when SSE reports a different
  // run so a deliberate retry cannot resolve to the previous terminal row.
  useEffect(() => {
    if (liveDetectionRunId) setRegenerateIdempotencyKey(crypto.randomUUID());
  }, [liveDetectionRunId]);
  useEffect(() => {
    if (liveTranscriptRunId) setTranscribeRetryKey(crypto.randomUUID());
  }, [liveTranscriptRunId]);

  const isIngestFailed = props.ingestStatus === "failed";
  const ingestStageWordLive = liveIngestStageWord(latestByStage, props.ingestStatus);

  const transcribeMerged = mergeStageWithLiveEvent(
    props.transcribe,
    latestByStage.stt,
    props.workflowRunId,
  );
  const detectMerged = mergeStageWithLiveEvent(
    props.detect,
    latestByStage.moment_detection,
    props.workflowRunId,
  );
  const renderMerged = mergeStageWithLiveEvent(
    props.render,
    latestByStage.clip_rendering,
    props.workflowRunId,
  );

  const nodes = deriveProcessingChecklist({
    ingestStatus: props.ingestStatus,
    transcribe: transcribeMerged,
    detect: detectMerged,
    render: renderMerged,
    mode: props.mode,
  });

  // Override the Import node's detail with the live-merged stage word — the
  // checklist derivation only sees the server-rendered ingestStatus.
  const displayNodes = nodes.map((node) =>
    node.id === "import" && node.state === "active"
      ? { ...node, detail: ingestStageWordLive }
      : node,
  );

  const noClipsDetected =
    detectMerged.status === "failed" && detectMerged.errorCode === "no_clips_detected";
  // A mid-run failure that isn't ingest and isn't the distinct "zero clips"
  // outcome (e.g. transcription itself failed, or detection failed for an
  // infra/LLM reason rather than finding nothing).
  const genericFailureStage: "transcribe" | "detect" | null =
    transcribeMerged.status === "failed"
      ? "transcribe"
      : detectMerged.status === "failed" && !noClipsDetected
        ? "detect"
        : null;

  const stopped = isIngestFailed || noClipsDetected || genericFailureStage !== null;
  // The step the run is on, or stopped at: what the header talks about.
  const currentIndex = displayNodes.findIndex((node) => node.state === "failed" || node.state === "active");
  const currentNode = currentIndex >= 0 ? displayNodes[currentIndex] : null;

  const detectionSettings = (
    <AdvancedClipSettings
      {...props.advancedSettingsProps}
      sourceLanguageEditable={false}
      defaultSourceLanguageCode={props.defaultSourceLanguageCode}
      compact
    />
  );
  const retryDetection = (label: string, pendingLabel: string) =>
    props.canEdit ? (
      <RetryForm
        action={regenerateClipsFormAction}
        projectId={props.projectId}
        idempotencyKey={regenerateIdempotencyKey}
        label={label}
        pendingLabel={pendingLabel}
        settings={detectionSettings}
      />
    ) : null;

  // Each stopped step explains itself and offers its next step in place, so
  // the panel never dead-ends and never repeats the message.
  const recovery: Partial<Record<ProcessingNodeId, ReactNode>> = {};
  if (isIngestFailed) {
    recovery.import = (
      <>
        <FailureMessage>{userErrorMessage(props.ingestErrorCode)}</FailureMessage>
        {!props.canEdit ? null : ingestRecoveryAction(props.ingestErrorCode, props.ingestFromDrivePicker) === "new_upload" ? (
          <Button asChild size="sm" variant="subtle" alignSelf="flex-start" mt="1">
            <Link href="/upload">{ingestRecoveryLabel(props.ingestFromDrivePicker)}</Link>
          </Button>
        ) : (
          <Box mt="1">
            <RetryIngestButton
              projectId={props.projectId}
              disabled={props.ingestAttemptsExhausted}
              limitReachedMessage={props.ingestRetryLimitMessage}
            />
          </Box>
        )}
      </>
    );
  }
  if (genericFailureStage === "transcribe") {
    recovery.transcribe = (
      <>
        <FailureMessage>{userErrorMessage(transcribeMerged.errorCode)}</FailureMessage>
        {props.canEdit ? (
          <RetryForm
            action={queueTranscriptionFormAction}
            projectId={props.projectId}
            idempotencyKey={transcribeRetryKey}
            label="Retry transcription"
            pendingLabel="Retrying…"
            settings={
              <AdvancedClipSettings
                {...props.advancedSettingsProps}
                sourceLanguageEditable={true}
                defaultSourceLanguageCode={props.defaultSourceLanguageCode}
                compact
              />
            }
          />
        ) : null}
      </>
    );
  } else if (genericFailureStage === "detect") {
    recovery.detect = (
      <>
        <FailureMessage>{userErrorMessage(detectMerged.errorCode)}</FailureMessage>
        {retryDetection("Retry detection", "Retrying…")}
      </>
    );
  } else if (noClipsDetected) {
    recovery.detect = (
      <>
        <FailureMessage>
          No clip-worthy moments found. Try adjusting the processing window or
          moment prompt, then re-run.
        </FailureMessage>
        {retryDetection("Re-run detection", "Starting…")}
      </>
    );
  }

  return (
    <Stack
      gap="7"
      maxW="640px"
      mx="auto"
      w="full"
      p={{ base: "5", md: "8" }}
      bg="bg.panel"
      borderRadius="l3"
      borderWidth="1px"
      borderColor="border.card"
    >
      <Stack gap="5">
        <Flex gap="4" align="center" direction={{ base: "column", sm: "row" }} textAlign={{ base: "center", sm: "left" }}>
          <Box w={{ base: "220px", sm: "168px" }} maxW="full" flexShrink={0}>
            {props.mediaWell}
          </Box>
          <Stack gap="1.5" minW="0" flex="1" align={{ base: "center", sm: "flex-start" }}>
            <Text textStyle="title" fontSize="16px" color="fg" lineClamp={2}>
              {props.projectTitle}
            </Text>
            <Flex align="center" gap="2" fontSize="13px" color={stopped ? "danger.fg" : "fg.muted"}>
              <Box
                boxSize="2"
                flexShrink={0}
                borderRadius="full"
                bg={stopped ? "danger.solid" : "accent.solid"}
                animation={stopped || !currentNode ? undefined : "pulse 1.6s ease-in-out infinite"}
              />
              <Text as="span" truncate>
                {stopped && currentNode
                  ? `Stopped at ${currentNode.label}`
                  : currentNode
                    ? `${currentNode.label}${currentNode.detail ? ` · ${currentNode.detail}` : ""}`
                    : "Finishing up"}
              </Text>
              {currentIndex >= 0 ? (
                <Text as="span" color="fg.subtle" flexShrink={0} fontVariantNumeric="tabular-nums">
                  · Step {currentIndex + 1} of {displayNodes.length}
                </Text>
              ) : null}
            </Flex>
          </Stack>
        </Flex>
        <RunSegments nodes={displayNodes} />
      </Stack>

      <ChecklistStepper nodes={displayNodes} recovery={recovery} />

      {/* Once a step has stopped, nothing continues in the background; the
          stopped step's recovery is the next step. */}
      {!stopped ? (
        <Flex
          align="center"
          justify="space-between"
          gap="3"
          wrap="wrap"
          px="3.5"
          py="2.5"
          borderRadius="l2"
          bg="bg.soft"
        >
          <Text fontSize="13px" color="fg.muted">
            Safe to leave this page; processing keeps going.
          </Text>
          {props.canEdit ? (
            <NotifyToggle projectId={props.projectId} initialNotifyOnComplete={props.notifyOnComplete} />
          ) : null}
        </Flex>
      ) : null}

      {/* Quota crossed mid-flight */}
      {props.quotaBlockedMessage && (
        <Box p="4" bg="bg.soft" borderRadius="l2">
          <PlanLimitNotice message={props.quotaBlockedMessage} upgrade={props.quotaUpgrade} />
        </Box>
      )}
    </Stack>
  );
}
