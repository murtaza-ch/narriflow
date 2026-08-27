"use client";

import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import { Check } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Meter } from "@narriflow/ui/components/meter";
import { Spinner } from "@narriflow/ui/components/spinner";
import { formatDuration, formatTransferRate } from "@/lib/format";
import type { RefObject } from "react";
import type { UploadSessionBrowserSnapshot } from "../_lib/upload-session-browser";

type UploadStage = "prepare" | "upload" | "finalize";

const UPLOAD_STAGES: { id: UploadStage; label: string }[] = [
  { id: "prepare", label: "Prepare" },
  { id: "upload", label: "Upload" },
  { id: "finalize", label: "Finalize" },
];

function UploadStages({
  stage,
  progress,
  throughput,
}: {
  stage: UploadStage;
  progress: number;
  throughput: { bytesPerSecond: number; etaSec: number | null } | null;
}) {
  const activeIndex = UPLOAD_STAGES.findIndex((candidate) => candidate.id === stage);
  return (
    <Stack gap="2.5">
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
                <Box color="success.fg" display="inline-flex">
                  <Check size={12} strokeWidth={2.5} />
                </Box>
              ) : state === "active" ? (
                <Spinner size="xs" />
              ) : (
                <Box w="6px" h="6px" borderRadius="1px" bg="border.emphasized" />
              )}
              <Text
                textStyle="eyebrow"
                color={state === "pending" ? "fg.subtle" : "fg"}
              >
                {candidate.label}
              </Text>
            </Flex>
          );
        })}
      </Flex>
      {stage === "upload" && (
        <>
          <Meter value={progress} />
          <Text textStyle="data" fontSize="11px" color="fg.muted">
            {progress}%
            {throughput
              ? ` · ${formatTransferRate(throughput.bytesPerSecond)}`
              : ""}
            {throughput?.etaSec != null
              ? ` · ETA ${formatDuration(throughput.etaSec)}`
              : ""}
          </Text>
        </>
      )}
    </Stack>
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
  const throughput =
    snapshot.bytesPerSecond && snapshot.bytesPerSecond > 0
      ? {
          bytesPerSecond: snapshot.bytesPerSecond,
          etaSec: snapshot.etaSeconds,
        }
      : null;
  const announcedProgress =
    snapshot.phase === "uploading"
      ? Math.floor(snapshot.progressPercent / 10) * 10
      : snapshot.progressPercent;

  return (
    <Box
      ref={statusRef}
      tabIndex={-1}
      role={snapshot.phase === "failed" ? "alert" : "status"}
      aria-atomic="true"
      borderTopWidth="1px"
      borderBottomWidth="1px"
      borderColor="border"
      py="3"
      ps="4"
      pe="3"
      position="relative"
      outline="none"
      _focusVisible={{
        boxShadow: "0 0 0 2px var(--chakra-colors-accent-solid)",
      }}
    >
      <Box
        position="absolute"
        insetInlineStart="0"
        top="0"
        bottom="0"
        w="3px"
        bg={
          snapshot.phase === "failed"
            ? "danger.solid"
            : snapshot.phase === "queued"
              ? "success.solid"
              : "accent.solid"
        }
      />
      <Stack gap="2.5">
        <Flex align="center" justify="space-between" gap="3">
          <Text textStyle="eyebrow" color="fg">
            {phaseLabel}
          </Text>
          {snapshot.phase === "uploading" && (
            <Text textStyle="data" fontSize="11px" color="fg.muted">
              {snapshot.progressPercent}%
            </Text>
          )}
        </Flex>
        {stage && (
          <UploadStages
            stage={stage}
            progress={snapshot.progressPercent}
            throughput={throughput}
          />
        )}
        <Text fontSize="12.5px" color="fg.muted" lineHeight="1.5">
          {snapshot.message}
        </Text>
        {snapshot.phase === "paused" && (
          <Text textStyle="data" fontSize="11px" color="fg.subtle">
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
        <Button type="button" variant="outline" size="md" onClick={onPause}>
          Pause
        </Button>
      )}
      {snapshot.canDiscard && (
        <Button
          type="button"
          variant="outline"
          size="md"
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
