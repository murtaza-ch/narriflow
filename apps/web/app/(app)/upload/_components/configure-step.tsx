"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, chakra, Flex, Stack, Text } from "@chakra-ui/react";
import { Info } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Textarea } from "@narriflow/ui/components/textarea";
import type {
  CaptionPresetId,
  ClipLengthPreset,
  ClipPlatformTarget,
  ContentPack,
  GenerationMode,
} from "@narriflow/validators";
import { Switch } from "@narriflow/ui/components/switch";
import { finalizeLinkConfigureAction, saveGenerationDraftAction } from "../actions";
import {
  buildLinkContentPack,
  type LinkConfigureState,
} from "../_lib/link-content-pack";
import { useIngestStream, type IngestStageStatus } from "../_lib/use-ingest-stream";
import { AdvancedSettings } from "./advanced-settings";
import { AspectRatioSelect } from "./aspect-ratio-select";
import { CaptionPresetGallery } from "./caption-preset-gallery";
import { ClipLengthChips } from "./clip-length-chips";
import { ImportPill } from "./import-pill";
import { RetryImportBand } from "./retry-import-band";
import { SettingsBand } from "./settings-band";

type DefaultAspectRatio = ContentPack["defaultAspectRatio"];
type CtaPhase = "idle" | "submitting" | "waiting";

interface ConfigureStepProps {
  projectId: string;
  title: string;
  sourceProvider: string | null;
  sourceMediaUrl: string;
  initialIngestStatus: IngestStageStatus;
  initialIngestErrorCode: string | null;
  mode: GenerationMode;
  languageCode: string;
  initialStep2: LinkConfigureState;
}

export function ConfigureStep({
  projectId,
  title,
  sourceProvider,
  sourceMediaUrl,
  initialIngestStatus,
  initialIngestErrorCode,
  mode,
  languageCode,
  initialStep2,
}: ConfigureStepProps) {
  const router = useRouter();
  const ingestStream = useIngestStream(projectId, {
    ingestStatus: initialIngestStatus,
    errorCode: initialIngestErrorCode,
  });

  const [clipLengthPreset, setClipLengthPreset] = useState<ClipLengthPreset>(
    initialStep2.clipLengthPreset,
  );
  const [captionPreset, setCaptionPreset] = useState<CaptionPresetId>(
    initialStep2.captionPreset,
  );
  const [defaultAspectRatio, setDefaultAspectRatio] = useState<DefaultAspectRatio>(
    initialStep2.defaultAspectRatio,
  );
  const [autoHook, setAutoHook] = useState(initialStep2.autoHook);
  const [autoRenderClips, setAutoRenderClips] = useState(initialStep2.autoRenderClips);
  const [specificMoments, setSpecificMoments] = useState(initialStep2.specificMoments);
  const [platformTargets, setPlatformTargets] = useState<ClipPlatformTarget[]>(
    initialStep2.platformTargets,
  );
  const [clipCountTarget, setClipCountTarget] = useState(initialStep2.clipCountTarget);
  const [toneConstraints, setToneConstraints] = useState(initialStep2.toneConstraints);

  const [ctaPhase, setCtaPhase] = useState<CtaPhase>("idle");
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [saveDraftError, setSaveDraftError] = useState<string | null>(null);

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
        autoRenderClips,
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
      autoRenderClips,
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
    const result = await saveGenerationDraftAction({
      projectId,
      contentPack: currentContentPack,
      languageCode: languageCode === "auto" ? null : languageCode,
    });
    if (!result.ok) {
      setSavingDraft(false);
      setSaveDraftError(result.message);
      return;
    }
    router.push(`/projects/${projectId}`);
  }

  async function submitFinalize() {
    setCtaPhase("submitting");
    setFinalizeError(null);

    const contentPack = currentContentPack;

    const result = await finalizeLinkConfigureAction({
      projectId,
      contentPack,
      languageCode: languageCode === "auto" ? null : languageCode,
    });

    if (!result.ok) {
      setCtaPhase("idle");
      setFinalizeError(result.message);
      return;
    }
    if (result.started) {
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
    <Stack gap="6" maxW="720px" mx="auto" animation="fade-up">
      <ImportPill
        title={title}
        sourceProvider={sourceProvider}
        sourceMediaUrl={sourceMediaUrl}
        ingestStatus={ingestStream.ingestStatus}
      />

      {mode === "clip" && (
        <SettingsBand eyebrow="Clip length">
          <ClipLengthChips value={clipLengthPreset} onChange={setClipLengthPreset} />
        </SettingsBand>
      )}

      <SettingsBand eyebrow="Caption preset">
        <CaptionPresetGallery value={captionPreset} onChange={setCaptionPreset} />
      </SettingsBand>

      <SettingsBand eyebrow="Aspect ratio">
        <AspectRatioSelect value={defaultAspectRatio} onChange={setDefaultAspectRatio} />
      </SettingsBand>

      {mode === "clip" ? (
        <SettingsBand eyebrow="Options">
          <Stack gap="3.5">
            <Flex align="center" justify="space-between" gap="3">
              <Box>
                <Text fontSize="13px" color="fg">
                  Auto-hook
                </Text>
                <Text fontSize="11px" color="fg.muted">
                  Prefer clips that open with a strong hook.
                </Text>
              </Box>
              <Switch checked={autoHook} onCheckedChange={setAutoHook} inputProps={{ name: "autoHook" }} />
            </Flex>
            <Flex align="center" justify="space-between" gap="3">
              <Box>
                <Text fontSize="13px" color="fg">
                  Auto-render after detection
                </Text>
              </Box>
              <Switch
                checked={autoRenderClips}
                onCheckedChange={setAutoRenderClips}
                inputProps={{ name: "autoRenderClips" }}
              />
            </Flex>
          </Stack>
        </SettingsBand>
      ) : (
        <SettingsBand eyebrow="Options">
          <Flex gap="2" align="flex-start">
            <Box color="fg.subtle" mt="0.5" flexShrink={0}>
              <Info size={13} strokeWidth={2} />
            </Box>
            <Text fontSize="12px" color="fg.muted" lineHeight="1.5">
              We transcribe your full video, then render it at original
              length with burned-in captions. No clipping.
            </Text>
          </Flex>
        </SettingsBand>
      )}

      {mode === "clip" && (
        <SettingsBand eyebrow="Find clip moment">
          <Textarea
            name="specificMoments"
            value={specificMoments}
            onChange={(event) => setSpecificMoments(event.target.value)}
            placeholder="e.g. When he builds the hero section"
            rows={3}
            maxLength={500}
            fontSize="13px"
          />
          <Text textStyle="data" fontSize="11px" color="fg.subtle" mt="1">
            {specificMoments.length}/500 · optional
          </Text>
        </SettingsBand>
      )}

      {mode === "clip" && (
        <Box>
          <AdvancedSettings
            platformTargets={platformTargets}
            onPlatformTargetsChange={setPlatformTargets}
            clipCountTarget={clipCountTarget}
            onClipCountTargetChange={setClipCountTarget}
            toneConstraints={toneConstraints}
            onToneConstraintsChange={setToneConstraints}
          />
        </Box>
      )}

      <Stack gap="3" pt="1">
        {ingestFailed ? (
          <RetryImportBand
            projectId={projectId}
            errorCode={ingestStream.errorCode}
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
      borderWidth="1px"
      borderColor="danger.muted"
                borderRadius="l2"
                position="relative"
                overflow="hidden"
              >
                <Text fontSize="12.5px" fontWeight="500" color="danger.fg">
                  {finalizeError}
                </Text>
              </Flex>
            )}
            <Button
              onClick={submitFinalize}
              disabled={ctaPhase !== "idle"}
              type="button"
              size="sm"
            >
              {ctaPhase === "waiting" ? (
                <>
                  <Spinner size="xs" borderTopColor="accent.contrast" />
                  <Text ms="1.5">Waiting for import…</Text>
                </>
              ) : ctaPhase === "submitting" ? (
                <>
                  <Spinner size="xs" borderTopColor="accent.contrast" />
                  <Text ms="1.5">Working…</Text>
                </>
              ) : (
                "Get AI clips"
              )}
            </Button>
            <Text fontSize="11px" color="fg.subtle" textAlign="center">
              You can leave this page —{" "}
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
                {savingDraft ? "saving…" : "finish this later"}
              </chakra.button>
              .
            </Text>
            {saveDraftError && (
              <Text fontSize="11px" color="danger.fg" textAlign="center">
                {saveDraftError}
              </Text>
            )}
          </>
        )}
      </Stack>
    </Stack>
  );
}
