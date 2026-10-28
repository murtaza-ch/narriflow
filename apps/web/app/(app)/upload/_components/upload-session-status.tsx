"use client";

import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Check, Pause, UploadCloud } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { PLAN_CATALOG } from "@narriflow/validators";
import { formatDuration, formatTransferRate } from "@/lib/format";
import type { RefObject } from "react";
import type { UpgradePrompt } from "../../_components/upgrade";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import type { UploadSessionBrowserSnapshot } from "../_lib/upload-session-browser";

type UploadStage = "prepare" | "upload" | "finalize";

const UPLOAD_STAGES: { id: UploadStage; label: string }[] = [
  { id: "prepare", label: "Prepare" },
  { id: "upload", label: "Upload" },
  { id: "finalize", label: "Finalize" },
];

/**
 * What a refused intake offers: the plan that admits it, opened in the shared
 * upgrade dialog by the owner, or whom to ask. It sends nothing, and the chosen
 * source and any saved Upload Session stay exactly as they are.
 */
export function UploadRefusalUpgrade({ prompt }: { prompt: UpgradePrompt }) {
  const plan = prompt.tier ? PLAN_CATALOG[prompt.tier] : null;
  if (!plan) return null;
  const offer = prompt.highlight
    ? `${plan.name} includes ${prompt.highlight.charAt(0).toLowerCase()}${prompt.highlight.slice(1)}.`
    : `${plan.name} lifts this limit.`;
  return (
    <PlanLimitNotice message={offer} upgrade={prompt} actionLabel={`See ${plan.name}`} />
  );
}

export function focusUploadSessionStatusForPhase(
  phase: UploadSessionBrowserSnapshot["phase"],
  target: Pick<HTMLElement, "focus"> | null,
) {
  if (phase === "paused" || phase === "failed") target?.focus();
}

/** Binary units, to match the transfer rate beside it. */
function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = safe;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : Number(value.toFixed(value >= 100 ? 0 : 1))} ${units[unit]}`;
}

/** A thick track with an accent fill; without a value it sweeps, for work with no measurable progress. */
function ProgressTrack({
  value,
  muted = false,
}: {
  /** 0-100, or null while the length of the work is unknown. */
  value: number | null;
  /** Paused: the fill goes neutral, so nothing looks like it is still moving. */
  muted?: boolean;
}) {
  const clamped = value === null ? null : Math.min(100, Math.max(0, value));
  return (
    <Box
      role="progressbar"
      aria-label="Upload progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped ?? undefined}
      h="1.5"
      bg="bg.muted"
      borderRadius="full"
      overflow="hidden"
    >
      {clamped === null ? (
        <Box
          h="full"
          backgroundImage="linear-gradient(90deg, transparent 20%, {colors.accent.solid} 50%, transparent 80%)"
          backgroundSize="200% 100%"
          animation="shimmer"
        />
      ) : (
        <Box
          h="full"
          borderRadius="full"
          bg={muted ? "fg.subtle" : "accent.solid"}
          transition="width 300ms ease, background 200ms ease"
          style={{ width: `${clamped}%` }}
        />
      )}
    </Box>
  );
}

/** Prepare, Upload, Finalize: where the upload is in its three steps. */
function UploadStages({ stage, complete }: { stage: UploadStage; complete: boolean }) {
  const activeIndex = complete
    ? UPLOAD_STAGES.length
    : UPLOAD_STAGES.findIndex((candidate) => candidate.id === stage);
  return (
    <Flex gap="5" wrap="wrap">
      {UPLOAD_STAGES.map((candidate, index) => {
        const state =
          index < activeIndex
            ? "done"
            : index === activeIndex
              ? "active"
              : "pending";
        return (
          <Flex key={candidate.id} align="center" gap="1.5">
            {state === "done" ? (
              <Box color="accent.fg" display="inline-flex" aria-hidden>
                <Check size={12} strokeWidth={2.5} />
              </Box>
            ) : (
              <Box
                aria-hidden
                boxSize="1.5"
                borderRadius="full"
                bg={state === "active" ? "accent.solid" : "bg.emphasized"}
              />
            )}
            <Text
              fontSize="12px"
              fontWeight="500"
              color={
                state === "active"
                  ? "fg"
                  : state === "done"
                    ? "fg.muted"
                    : "fg.subtle"
              }
            >
              {candidate.label}
            </Text>
          </Flex>
        );
      })}
    </Flex>
  );
}

/** The panel's leading mark: what the upload is doing, in the phase's own tone. */
function PhaseMark({ phase }: { phase: UploadSessionBrowserSnapshot["phase"] }) {
  const tone =
    phase === "failed"
      ? { bg: "danger.muted", color: "danger.fg" }
      : phase === "paused"
        ? { bg: "bg.muted", color: "fg.muted" }
        : { bg: "accent.subtle", color: "accent.fg" };
  return (
    <Flex
      boxSize="9"
      flexShrink={0}
      align="center"
      justify="center"
      borderRadius="l2"
      bg={tone.bg}
      color={tone.color}
      aria-hidden
    >
      {phase === "preparing" || phase === "verifying" ? (
        <Spinner size="sm" borderTopColor="accent.fg" />
      ) : phase === "failed" ? (
        <AlertTriangle size={16} strokeWidth={2} />
      ) : phase === "paused" ? (
        <Pause size={16} strokeWidth={2} />
      ) : phase === "queued" ? (
        <Check size={16} strokeWidth={2.5} />
      ) : (
        <UploadCloud size={16} strokeWidth={2} />
      )}
    </Flex>
  );
}

export function UploadSessionStatusPanel({
  snapshot,
  statusRef,
}: {
  snapshot: UploadSessionBrowserSnapshot;
  statusRef?: RefObject<HTMLDivElement | null>;
}) {
  if (snapshot.phase === "idle") return null;
  const phaseLabel = {
    preparing: "Preparing",
    uploading: "Uploading",
    paused: "Paused",
    verifying: "Verifying",
    queued: "Queued",
    failed: "Failed",
  }[snapshot.phase];
  const stage: UploadStage | null =
    snapshot.phase === "preparing"
      ? "prepare"
      : snapshot.phase === "uploading" || snapshot.phase === "paused"
        ? "upload"
        : snapshot.phase === "verifying" || snapshot.phase === "queued"
          ? "finalize"
          : null;
  const announcedProgress =
    snapshot.phase === "uploading"
      ? Math.floor(snapshot.progressPercent / 10) * 10
      : snapshot.progressPercent;
  const failed = snapshot.phase === "failed";
  const paused = snapshot.phase === "paused";
  const transferring = snapshot.phase === "uploading" || paused;
  // What the upload is doing in numbers: size, then speed and time left while bytes flow.
  const detail = transferring
    ? [
        `${formatBytes(snapshot.transferredBytes)} of ${formatBytes(snapshot.totalBytes)}`,
        snapshot.phase === "uploading" &&
        snapshot.bytesPerSecond &&
        snapshot.bytesPerSecond > 0
          ? formatTransferRate(snapshot.bytesPerSecond)
          : null,
        snapshot.phase === "uploading" && snapshot.etaSeconds != null
          ? `${formatDuration(snapshot.etaSeconds)} left`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  // Uploading's own message only restates the title; every other phase has something to say.
  const showMessage = snapshot.phase !== "uploading" && !failed;

  return (
    <Box
      ref={statusRef}
      tabIndex={-1}
      role={failed ? "alert" : undefined}
      aria-atomic={failed ? "true" : undefined}
      bg={failed ? "danger.subtle" : "bg.subtle"}
      borderRadius="l3"
      p="4"
      position="relative"
      outline="none"
      _focusVisible={{
        outline: "2px solid",
        outlineColor: "accent.solid",
        outlineOffset: "2px",
      }}
    >
      <Stack gap="3.5">
        <Flex align={failed ? "flex-start" : "center"} gap="3">
          <PhaseMark phase={snapshot.phase} />
          <Box flex="1" minW="0">
            <Text fontSize="14px" fontWeight="500" color="fg" lineHeight="1.3">
              {phaseLabel}
            </Text>
            {failed ? (
              <Text fontSize="13px" color="fg.muted" lineHeight="1.5" mt="0.5">
                {snapshot.message}
              </Text>
            ) : null}
            {failed && snapshot.upgrade ? (
              <UploadRefusalUpgrade prompt={snapshot.upgrade} />
            ) : null}
            {detail ? (
              <Text
                fontSize="12px"
                color="fg.muted"
                fontVariantNumeric="tabular-nums"
                lineHeight="1.4"
                truncate
              >
                {detail}
              </Text>
            ) : null}
          </Box>
          {transferring ? (
            <Text
              fontSize="20px"
              fontWeight="500"
              letterSpacing="-0.02em"
              fontVariantNumeric="tabular-nums"
              color={paused ? "fg.muted" : "fg"}
              flexShrink={0}
            >
              {snapshot.progressPercent}%
            </Text>
          ) : null}
        </Flex>
        {!failed && (
          <ProgressTrack
            value={
              transferring
                ? snapshot.progressPercent
                : snapshot.phase === "queued"
                  ? 100
                  : null
            }
            muted={paused}
          />
        )}
        {stage && <UploadStages stage={stage} complete={snapshot.phase === "queued"} />}
        {showMessage && (
          <Text fontSize="13px" color="fg.muted" lineHeight="1.5">
            {snapshot.message}
          </Text>
        )}
        {paused && (
          <Text fontSize="12px" color="fg.subtle" lineHeight="1.5">
            Your saved title, brand, language, and generation settings remain
            attached to this Upload Session.
          </Text>
        )}
        <Text
          position="absolute"
          w="1px"
          h="1px"
          overflow="hidden"
          clip="rect(0 0 0 0)"
          whiteSpace="nowrap"
          aria-live="polite"
        >
          {snapshot.phase === "uploading"
            ? `Upload ${announcedProgress} percent complete.`
            : `${phaseLabel}. ${snapshot.message}`}
        </Text>
      </Stack>
    </Box>
  );
}

export function UploadSessionSecondaryActions({
  snapshot,
  onPause,
  onDiscard,
}: {
  snapshot: UploadSessionBrowserSnapshot;
  onPause(): void;
  onDiscard(): void;
}) {
  if (!snapshot.canPause && !snapshot.canDiscard) return null;
  return (
    <HStack gap="2">
      {snapshot.canPause && (
        <Button type="button" variant="subtle" size="sm" onClick={onPause}>
          Pause
        </Button>
      )}
      {snapshot.canDiscard && (
        <Button
          type="button"
          variant="subtle"
          size="sm"
          color="danger.fg"
          aria-label="Discard this upload"
          onClick={onDiscard}
        >
          Discard
        </Button>
      )}
    </HStack>
  );
}
