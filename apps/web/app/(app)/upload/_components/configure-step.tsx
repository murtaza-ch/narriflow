"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { linkMetadataQueryOptions } from "@narriflow/api-client/ingest";
import { useQuery } from "@tanstack/react-query";
import { chakra, Flex, Stack, Text } from "@chakra-ui/react";
import { Sparkles, ArrowRight } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  detectLinkProvider,
  type CaptionPresetId,
  type ClipLengthPreset,
  type ClipPlatformTarget,
  type ContentPack,
  type GenerationMode,
} from "@narriflow/validators";
import { isApiError } from "@narriflow/api-client/core";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
import type { UpgradePrompt } from "../../_components/upgrade";
import { useIntake } from "../_lib/intake-context";
import { failureFromApiError, intakeFailureMessage } from "../_lib/intake-failure";
import { UploadRefusalUpgrade } from "./upload-session-status";
import {
  buildLinkContentPack,
  type LinkConfigureState,
} from "../_lib/link-content-pack";
import {
  useIngestStream,
  type IngestStageStatus,
} from "../_lib/use-ingest-stream";
import { ClipStyleSettings } from "./clip-style-settings";
import { ImportPill } from "./import-pill";
import { RetryImportBand } from "./retry-import-band";

type DefaultAspectRatio = ContentPack["defaultAspectRatio"];
type CtaPhase = "idle" | "submitting" | "waiting";

interface ConfigureStepProps {
  projectId: string;
  title: string;
  sourceMediaUrl: string;
  sourceInput: string | null;
  initialIngestStatus: IngestStageStatus;
  initialIngestErrorCode: string | null;
  /** The ingest is a Google Drive Picker import, which can't be retried. */
  ingestFromDrivePicker: boolean;
  mode: GenerationMode;
  languageCode: string;
  initialStep2: LinkConfigureState;
}

export function ConfigureStep({
  projectId,
  title,
  sourceMediaUrl,
  sourceInput,
  initialIngestStatus,
  initialIngestErrorCode,
  ingestFromDrivePicker,
  mode,
  languageCode,
  initialStep2,
}: ConfigureStepProps) {
  const router = useRouter();
  const intake = useIntake();
  // What the stream starts from. A retry hands it a fresh queued import.
  const [ingestStart, setIngestStart] = useState({
    ingestStatus: initialIngestStatus,
    errorCode: initialIngestErrorCode,
  });
  // Counts accepted retries, so a retry resets the stream even though it restarts at the same queued/null.
  const [retryAttempt, setRetryAttempt] = useState(0);
  const ingestStream = useIngestStream(projectId, ingestStart, { attempt: retryAttempt });

  const [clipLengthPreset, setClipLengthPreset] = useState<ClipLengthPreset>(
    initialStep2.clipLengthPreset,
  );
  const [captionPreset, setCaptionPreset] = useState<CaptionPresetId>(
    initialStep2.captionPreset,
  );
  const [defaultAspectRatio, setDefaultAspectRatio] =
    useState<DefaultAspectRatio>(initialStep2.defaultAspectRatio);
  const [autoHook, setAutoHook] = useState(initialStep2.autoHook);
  const [specificMoments, setSpecificMoments] = useState(
    initialStep2.specificMoments,
  );
  const [platformTargets, setPlatformTargets] = useState<ClipPlatformTarget[]>(
    initialStep2.platformTargets,
  );
  const [clipCountTarget, setClipCountTarget] = useState(
    initialStep2.clipCountTarget,
  );
  const [toneConstraints, setToneConstraints] = useState(
    initialStep2.toneConstraints,
  );

  const [ctaPhase, setCtaPhase] = useState<CtaPhase>("idle");
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  // Set when Processing Usage refused generation for credits or length and a plan would admit it.
  const [finalizeUpgrade, setFinalizeUpgrade] = useState<UpgradePrompt | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [saveDraftError, setSaveDraftError] = useState<string | null>(null);
  const [displayTitle, setDisplayTitle] = useState(title);

  // A link imported without a title shows the one YouTube publishes; no title is simply no change.
  const { data: metadata } = useQuery({
    ...linkMetadataQueryOptions({ transport: intake.transport, scope: intake.scope, url: sourceMediaUrl }),
    enabled: title === "Link Import" && detectLinkProvider(sourceMediaUrl) === "youtube",
  });
  useEffect(() => {
    if (metadata?.title) setDisplayTitle(metadata.title);
  }, [metadata?.title]);

  // Same builder finalize uses, kept as one ContentPack the "finish later"
  // paths and the CTA both read from — a user who never touches these
  // fields still gets `initialStep2`'s resumed/default values saved, not an
  // empty pack.
  const currentContentPack = useMemo(
    () =>
      buildLinkContentPack({
        mode,
        clipLengthPreset,
        captionPreset,
        defaultAspectRatio,
        autoHook,
        specificMoments,
        platformTargets,
        clipCountTarget,
        toneConstraints,
        processingStartSec: initialStep2.processingStartSec,
        processingEndSec: initialStep2.processingEndSec,
      }),
    [
      mode,
      clipLengthPreset,
      captionPreset,
      defaultAspectRatio,
      autoHook,
      specificMoments,
      platformTargets,
      clipCountTarget,
      toneConstraints,
      initialStep2.processingStartSec,
      initialStep2.processingEndSec,
    ],
  );

  // "Save settings and finish later" — used by both the failure band's link
  // and the plain CTA-area link below. Persists the current form values as
  // a draft ContentPack (never triggers generation) before navigating away;
  // a bare `<Link href="/projects/...">` would silently discard whatever
  // the user just configured in Step 2.
  async function handleSaveAndFinishLater() {
    if (savingDraft) return;
    setSavingDraft(true);
    setSaveDraftError(null);
    try {
      await intake.actions.saveDraft(projectId, {
        contentPack: currentContentPack,
        languageCode: languageCode === "auto" ? null : languageCode,
      });
    } catch (error) {
      setSavingDraft(false);
      setSaveDraftError(intakeFailureMessage(error, "Could not save your settings. Please try again."));
      return;
    }
    void intake.accepted();
    router.push(`/projects/${projectId}`);
  }

  async function submitFinalize() {
    setCtaPhase("submitting");
    setFinalizeError(null);
    setFinalizeUpgrade(null);

    let result: Awaited<ReturnType<typeof intake.actions.finalize>>;
    try {
      result = await intake.actions.finalize(projectId, {
        contentPack: currentContentPack,
        languageCode: languageCode === "auto" ? null : languageCode,
      });
    } catch (error) {
      setCtaPhase("idle");
      setFinalizeError(intakeFailureMessage(error, "Could not start clip generation. Please try again."));
      // Same refusal shape as Commit, so Configure can offer the plan that admits the source.
      setFinalizeUpgrade(isApiError(error) ? upgradePromptFromFailure(failureFromApiError(error)) : null);
      return;
    }
    if (result.started) {
      void intake.accepted();
      router.push(`/projects/${projectId}`);
      return;
    }
    // started:false — either still running (wait for the SSE effect below to
    // re-invoke) or ingest just failed (the RetryImportBand below takes over
    // as soon as ingestStream reflects it).
    setCtaPhase(result.ingestStatus === "failed" ? "idle" : "waiting");
  }

  const submitFinalizeEvent = useEffectEvent(submitFinalize);

  // The CTA's guarantee to always resolve: once ingest hits "ready" while
  // we're waiting on it, re-invoke finalize automatically. The worker's own
  // trigger usually wins the race (Phase 0's ordering invariant); this is
  // the client-side backstop either way.
  useEffect(() => {
    if (ctaPhase === "waiting" && ingestStream.ingestStatus === "ready") {
      void submitFinalizeEvent();
    }
  }, [ingestStream.ingestStatus, ctaPhase]);

  const ingestFailed = ingestStream.ingestStatus === "failed";

  return (
    <Stack gap="5" maxW="860px" mx="auto" animation="fade-up">
      <ImportPill
        title={displayTitle}
        sourceMediaUrl={sourceMediaUrl}
        sourceInput={sourceInput}
        ingestStatus={ingestStream.ingestStatus}
      />
      <ClipStyleSettings
        mode={mode}
        defaultAspectRatio={defaultAspectRatio}
        setDefaultAspectRatio={setDefaultAspectRatio}
        clipLengthPreset={clipLengthPreset}
        setClipLengthPreset={setClipLengthPreset}
        captionPreset={captionPreset}
        setCaptionPreset={setCaptionPreset}
        autoHook={autoHook}
        setAutoHook={setAutoHook}
        specificMoments={specificMoments}
        setSpecificMoments={setSpecificMoments}
        platformTargets={platformTargets}
        setPlatformTargets={setPlatformTargets}
        clipCountTarget={clipCountTarget}
        setClipCountTarget={setClipCountTarget}
        toneConstraints={toneConstraints}
        setToneConstraints={setToneConstraints}
      />
      <Stack
        gap="2.5"
        position="sticky"
        bottom="0"
        zIndex="10"
        bg="bg"
        py="4"
      >
        {ingestFailed ? (
          <RetryImportBand
            projectId={projectId}
            errorCode={ingestStream.errorCode}
            fromDrivePicker={ingestFromDrivePicker}
            onRetried={() => {
              setIngestStart({ ingestStatus: "queued", errorCode: null });
              setRetryAttempt((attempt) => attempt + 1);
            }}
            onSaveAndFinishLater={handleSaveAndFinishLater}
            savingDraft={savingDraft}
            saveDraftError={saveDraftError}
          />
        ) : (
          <>
            {finalizeError && (
              <Flex
                role="alert"
                align="center"
                gap="2.5"
                px="3"
                py="2.5"
                bg="danger.subtle"
                borderRadius="l2"
                position="relative"
                overflow="hidden"
              >
                <Text fontSize="13px" fontWeight="500" color="danger.fg">
                  {finalizeError}
                </Text>
              </Flex>
            )}
            {finalizeError && finalizeUpgrade && <UploadRefusalUpgrade prompt={finalizeUpgrade} />}
            <Button
              onClick={submitFinalize}
              disabled={ctaPhase !== "idle"}
              type="button"
              size="md"
              h="46px"
              w="full"
              maxW="400px"
              mx="auto"
            >
              {ctaPhase === "waiting" ? (
                <>
                  <Spinner size="xs" borderTopColor="brand.contrast" />
                  <Text ms="1.5">Waiting for import…</Text>
                </>
              ) : ctaPhase === "submitting" ? (
                <>
                  <Spinner size="xs" borderTopColor="brand.contrast" />
                  <Text ms="1.5">Working…</Text>
                </>
              ) : (
                <>
                  <Sparkles size={16} />
                  {mode === "clip" ? "Get AI clips" : "Create captioned video"}
                  <ArrowRight size={16} />
                </>
              )}
            </Button>
            <Text fontSize="12px" color="fg.subtle" textAlign="center">
              Need more time?{" "}
              <chakra.button
                type="button"
                onClick={handleSaveAndFinishLater}
                disabled={savingDraft}
                color="fg"
                textDecoration="underline"
                textUnderlineOffset="2px"
                cursor={savingDraft ? "default" : "pointer"}
                opacity={savingDraft ? 0.6 : 1}
                _hover={savingDraft ? undefined : { color: "fg.muted" }}
              >
                {savingDraft ? "saving…" : "Save and finish later"}
              </chakra.button>
              .
            </Text>
            {saveDraftError && (
              <Text fontSize="12px" color="danger.fg" textAlign="center">
                {saveDraftError}
              </Text>
            )}
          </>
        )}
      </Stack>
    </Stack>
  );
}
