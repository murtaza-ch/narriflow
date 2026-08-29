"use client";

import { type ReactNode, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { ActionSubmitButton } from "@narriflow/ui/components/action-submit-button";
import { Switch } from "@narriflow/ui/components/switch";
import { GhostFrame } from "@narriflow/ui/components/ghost-frame";
import { userErrorMessage, type CaptionPresetId } from "@narriflow/validators";
import { AlertTriangle, Check, RotateCcw } from "lucide-react";
import { formatDuration } from "@/lib/format";
import {
  deriveProcessingChecklist,
  ingestRecoveryAction,
  liveIngestStageWord,
  mergeStageWithLiveEvent,
  type PipelineStepState,
  type ProcessingStageInput,
} from "@/lib/project-state";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
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

const NODE_COLORS: Record<
  PipelineStepState,
  { node: string; connector: string; label: string }
> = {
  done: { node: "success.solid", connector: "success.solid", label: "fg" },
  active: { node: "accent.solid", connector: "border.emphasized", label: "fg" },
  failed: { node: "danger.solid", connector: "border", label: "danger.fg" },
  todo: { node: "border.emphasized", connector: "border", label: "fg.subtle" },
};

function ChecklistStepper({
  nodes,
}: {
  nodes: ReturnType<typeof deriveProcessingChecklist>;
}) {
  return (
    <Stack as="ol" gap="0" listStyleType="none" m="0" p="0">
      {nodes.map((node, index) => {
        const colors = NODE_COLORS[node.state];
        const isLast = index === nodes.length - 1;
        return (
          <Flex key={node.id} as="li" gap="3" align="stretch">
            <Flex direction="column" align="center" flexShrink={0}>
              <Flex
                w="20px"
                h="20px"
                align="center"
                justify="center"
                borderRadius="full"
                borderWidth="1.5px"
                borderColor={colors.node}
                bg={node.state === "done" ? "success.subtle" : "transparent"}
                flexShrink={0}
              >
                {node.state === "done" ? (
                  <Box asChild color="success.fg" aria-label="complete">
                    <Check size={11} strokeWidth={3} />
                  </Box>
                ) : node.state === "failed" ? (
                  <Box asChild color="danger.fg" aria-label="failed">
                    <AlertTriangle size={11} />
                  </Box>
                ) : (
                  <Text textStyle="data" fontSize="10px" lineHeight="1" color={colors.label}>
                    {index + 1}
                  </Text>
                )}
              </Flex>
              {!isLast && (
                <Box w="1.5px" flex="1" minH="24px" bg={colors.connector} my="1" />
              )}
            </Flex>
            <Stack gap="0.5" pb={isLast ? "0" : "5"} pt="0.5">
              <Flex align="center" gap="2">
                <Text fontSize="13.5px" fontWeight="500" color={colors.label}>
                  {node.label}
                </Text>
                {node.detail && (
                  <Text textStyle="data" fontSize="11px" color="fg.subtle">
                    {node.detail}
                  </Text>
                )}
              </Flex>
              {node.errorCode && node.state === "failed" && (
                <Flex align="center" gap="1.5" color="danger.fg" mt="0.5">
                  <AlertTriangle size={12} aria-hidden />
                  <Text fontSize="xs">{userErrorMessage(node.errorCode)}</Text>
                </Flex>
              )}
            </Stack>
          </Flex>
        );
      })}
    </Stack>
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
  durationSec: number | null;
  notifyOnComplete: boolean;
  ingestStatus: string;
  ingestErrorCode: string | null;
  ingestAttemptsExhausted: boolean;
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
  autoRenderClips: boolean;
  clipCount: number;
  hasAnyRendered: boolean;
  quotaBlockedMessage: string | null;
  advancedSettingsProps: {
    sourceDurationSec: number | null;
    defaultProcessingStartSec: number | null;
    defaultProcessingEndSec: number | null;
    defaultCaptionPreset: CaptionPresetId;
  };
  defaultSourceLanguageCode: string | null;
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
  // Stable across re-renders (not regenerated on every SSE-driven update) —
  // only read at form submission time.
  const [regenerateIdempotencyKey] = useState(() => crypto.randomUUID());
  const [transcribeRetryKey] = useState(() => crypto.randomUUID());

  const isIngestFailed = props.ingestStatus === "failed";
  const ingestStageWordLive = liveIngestStageWord(latestByStage, props.ingestStatus);

  const transcribeMerged = mergeStageWithLiveEvent(
    props.transcribe,
    latestByStage.stt,
  );
  const detectMerged = mergeStageWithLiveEvent(
    props.detect,
    latestByStage.moment_detection,
  );
  const renderMerged = mergeStageWithLiveEvent(
    props.render,
    latestByStage.clip_rendering,
  );

  const nodes = deriveProcessingChecklist({
    ingestStatus: props.ingestStatus,
    transcribe: transcribeMerged,
    detect: detectMerged,
    render: renderMerged,
    mode: props.mode,
    autoRenderClips: props.autoRenderClips,
    clipCount: props.clipCount,
    hasAnyRendered: props.hasAnyRendered,
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
  // empty state (e.g. transcription itself failed, or detection failed for
  // an infra/LLM reason rather than finding nothing) — the checklist above
  // already shows which node and why; this band is the actionable retry the
  // Step 01/02 forms used to provide before the panel replaced them.
  const genericFailureStage: "transcribe" | "detect" | null =
    transcribeMerged.status === "failed"
      ? "transcribe"
      : detectMerged.status === "failed" && !noClipsDetected
        ? "detect"
        : null;

  return (
    <Stack gap="6" maxW="560px" mx="auto" w="full" py="4">
      <Stack gap="3" align="center" textAlign="center">
        <Box w="180px">{props.mediaWell}</Box>
        <Stack gap="1" align="center">
          <Text textStyle="title" fontSize="16px" color="fg" lineClamp={2}>
            {props.projectTitle}
          </Text>
          {typeof props.durationSec === "number" && props.durationSec > 0 && (
            <Text textStyle="data" fontSize="12px" color="fg.timecode">
              {formatDuration(props.durationSec)}
            </Text>
          )}
        </Stack>
        <Text fontSize="sm" color="fg.muted" maxW="42ch">
          You can safely leave this page — progress continues in the
          background.
        </Text>
        <NotifyToggle
          projectId={props.projectId}
          initialNotifyOnComplete={props.notifyOnComplete}
        />
      </Stack>

      <Box layerStyle="band">
        <ChecklistStepper nodes={displayNodes} />
      </Box>

      {/* State matrix — ingest failed */}
      {isIngestFailed && (
        <Box
          position="relative"
          ps="4"
          py="3"
          borderWidth="1px"
          borderColor="border"
          borderRadius="l2"
          overflow="hidden"
        >
          <Box position="absolute" insetInlineStart="0" top="0" bottom="0" w="3px" bg="danger.solid" />
          <Stack gap="2">
            <Flex align="center" gap="2" color="danger.fg">
              <AlertTriangle size={14} aria-hidden />
              <Text fontSize="sm">{userErrorMessage(props.ingestErrorCode)}</Text>
            </Flex>
            {ingestRecoveryAction(props.ingestErrorCode) === "new_upload" ? (
              <Button asChild size="xs" variant="outline" alignSelf="flex-start">
                <Link href="/upload">Upload video instead</Link>
              </Button>
            ) : (
              <RetryIngestButton
                projectId={props.projectId}
                disabled={props.ingestAttemptsExhausted}
                limitReachedMessage={props.ingestRetryLimitMessage}
              />
            )}
          </Stack>
        </Box>
      )}

      {/* State matrix — quota crossed mid-flight */}
      {props.quotaBlockedMessage && (
        <Box
          position="relative"
          ps="4"
          py="3"
          borderWidth="1px"
          borderColor="border"
          borderRadius="l2"
          overflow="hidden"
        >
          <Box position="absolute" insetInlineStart="0" top="0" bottom="0" w="3px" bg="warning.solid" />
          <PlanLimitNotice message={props.quotaBlockedMessage} />
        </Box>
      )}

      {/* Generic mid-run failure (not ingest, not the zero-clips empty
          state) — an actionable retry so the panel never dead-ends. */}
      {genericFailureStage && (
        <Box
          position="relative"
          ps="4"
          py="3"
          borderWidth="1px"
          borderColor="border"
          borderRadius="l2"
          overflow="hidden"
        >
          <Box position="absolute" insetInlineStart="0" top="0" bottom="0" w="3px" bg="danger.solid" />
          <Stack gap="2">
            <Flex align="center" gap="2" color="danger.fg">
              <AlertTriangle size={14} aria-hidden />
              <Text fontSize="sm">
                {userErrorMessage(
                  genericFailureStage === "transcribe"
                    ? transcribeMerged.errorCode
                    : detectMerged.errorCode,
                )}
              </Text>
            </Flex>
            {genericFailureStage === "transcribe" ? (
              <AuthenticatedActionForm action={queueTranscriptionFormAction}>
                <input type="hidden" name="projectId" value={props.projectId} />
                <input type="hidden" name="idempotencyKey" value={transcribeRetryKey} />
                <Flex align="center" gap="2" wrap="wrap">
                  <ActionSubmitButton pendingLabel="Retrying…" size="sm">
                    <RotateCcw size={12} />
                    <Text ms="1">Retry transcription</Text>
                  </ActionSubmitButton>
                  <AdvancedClipSettings
                    {...props.advancedSettingsProps}
                    sourceLanguageEditable={true}
                    defaultSourceLanguageCode={props.defaultSourceLanguageCode}
                    compact
                  />
                </Flex>
              </AuthenticatedActionForm>
            ) : (
              <AuthenticatedActionForm action={regenerateClipsFormAction}>
                <input type="hidden" name="projectId" value={props.projectId} />
                <input type="hidden" name="idempotencyKey" value={regenerateIdempotencyKey} />
                <Flex align="center" gap="2" wrap="wrap">
                  <ActionSubmitButton pendingLabel="Retrying…" size="sm">
                    <RotateCcw size={12} />
                    <Text ms="1">Retry detection</Text>
                  </ActionSubmitButton>
                  <AdvancedClipSettings
                    {...props.advancedSettingsProps}
                    sourceLanguageEditable={false}
                    defaultSourceLanguageCode={props.defaultSourceLanguageCode}
                    compact
                  />
                </Flex>
              </AuthenticatedActionForm>
            )}
          </Stack>
        </Box>
      )}

      {/* State matrix — zero clip-worthy moments found (terminal failure,
          distinct from the generic danger band above). */}
      {noClipsDetected && (
        <Flex direction="column" align="center" gap="4" py="8" textAlign="center">
          <GhostFrame ratio={9 / 16} size="88px" />
          <Stack gap="1" align="center">
            <Text textStyle="title" fontSize="15px" color="fg">
              No clip-worthy moments found
            </Text>
            <Text fontSize="sm" color="fg.muted" maxW="40ch">
              Detection finished but didn't find anything worth clipping. Try
              adjusting the processing window or moment prompt, then re-run.
            </Text>
          </Stack>
          <AuthenticatedActionForm action={regenerateClipsFormAction}>
            <input type="hidden" name="projectId" value={props.projectId} />
            <input
              type="hidden"
              name="idempotencyKey"
              value={regenerateIdempotencyKey}
            />
            <Flex align="center" gap="2" wrap="wrap" justify="center">
              <ActionSubmitButton pendingLabel="Starting…" size="sm">
                <RotateCcw size={12} />
                <Text ms="1">Re-run detection</Text>
              </ActionSubmitButton>
              <AdvancedClipSettings
                {...props.advancedSettingsProps}
                sourceLanguageEditable={false}
                defaultSourceLanguageCode={props.defaultSourceLanguageCode}
                compact
              />
            </Flex>
          </AuthenticatedActionForm>
        </Flex>
      )}
    </Stack>
  );
}
