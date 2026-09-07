"use client";

import { useEffect, useRef, useState } from "react";
import { Box, chakra, Flex, Portal, Popover, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Clock, Link2 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  isProcessingQuotaExceeded,
  LINK_PROVIDERS,
  processingMinutesFromSeconds,
  type BrandTemplateSummary,
  type GenerationMode,
  type LinkProviderId,
} from "@narriflow/validators";
import { formatTimecode } from "@/lib/format";
import { extractYoutubeId, youtubeThumbnailUrl } from "../../projects/_lib/youtube";
import { ProcessingTimeline } from "../../_shared/processing-timeline";
import { BrandTemplatePicker } from "./brand-template-picker";
import { LanguageSelect } from "./language-select";
import { ModeTabs } from "./mode-tabs";
import { VideoPreview } from "./video-preview";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { fetchYoutubeMetadataAction, commitLinkImportAction } from "../actions";
import { isAuthenticatedActionFailure } from "@/lib/authenticated-request-browser";

function linkProviderLabel(provider: LinkProviderId): string {
  return LINK_PROVIDERS.find((p) => p.id === provider)?.label ?? "Link";
}

/** Failure notice: Labeled danger panel with an icon. */
function ErrorNotice({ message }: { message: string }) {
  return (
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
      <Box color="danger.fg" flexShrink={0}>
        <AlertTriangle size={14} strokeWidth={2} />
      </Box>
      <Text fontSize="12.5px" fontWeight="500" color="danger.fg">
        {message}
      </Text>
    </Flex>
  );
}

interface UsageSummary {
  tier: string;
  usedMinutes: number;
  limitMinutes: number;
  maxUploadSeconds: number;
}

export interface CommitStepResult {
  projectId: string;
  title: string;
  languageCode: string;
  mode: GenerationMode;
  processingStartSec: number | null;
  processingEndSec: number | null;
}

interface CommitStepProps {
  linkUrl: string;
  linkProvider: LinkProviderId;
  brandTemplates: {
    builtIns: BrandTemplateSummary[];
    mine: BrandTemplateSummary[];
    defaultId: string | null;
  };
  brandProfiles: {
    items: Array<{
      id: string;
      name: string;
      defaultTemplateId: string | null;
      templates: Array<{ id: string; name: string }>;
    }>;
    defaultId: string | null;
  };
  usageSummary: UsageSummary;
  commitToken: string;
  onCommitted: (result: CommitStepResult) => void;
  onChangeSource: () => void;
}

export function CommitStep({
  linkUrl,
  linkProvider,
  brandTemplates,
  brandProfiles,
  usageSummary,
  commitToken,
  onCommitted,
  onChangeSource,
}: CommitStepProps) {
  const [title, setTitle] = useState("");
  const titleTouchedRef = useRef(false);
  const [languageCode, setLanguageCode] = useState("auto");
  const [mode, setMode] = useState<GenerationMode>("clip");
  const defaultBrandProfile = brandProfiles.items.find(
    (profile) => profile.id === brandProfiles.defaultId,
  );
  const [brandTemplateId, setBrandTemplateId] = useState<string | null>(
    defaultBrandProfile
      ? defaultBrandProfile.defaultTemplateId
      : brandTemplates.defaultId,
  );
  const [brandProfileId, setBrandProfileId] = useState<string | null>(
    brandProfiles.defaultId,
  );

  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const youtubeId = linkProvider === "youtube" ? extractYoutubeId(linkUrl) : null;

  // YouTube oEmbed prefill — server-side fetch, ~3s timeout, silent fallback.
  useEffect(() => {
    if (linkProvider !== "youtube") return;
    let cancelled = false;
    fetchYoutubeMetadataAction(linkUrl)
      .then((result) => {
        if (
          cancelled ||
          titleTouchedRef.current ||
          isAuthenticatedActionFailure(result) ||
          !result.title
        ) return;
        setTitle(result.title);
      })
      .catch(() => {
        // Silent fallback — title stays editable and empty.
      });
    return () => {
      cancelled = true;
    };
  }, [linkUrl, linkProvider]);

  function handleDurationKnown(seconds: number) {
    setDurationSec((prev) => {
      if (prev === seconds) return prev;
      setStartSec(0);
      setEndSec(seconds);
      return seconds;
    });
  }

  const hasKnownDuration = typeof durationSec === "number" && durationSec > 0;
  const hasCustomWindow =
    hasKnownDuration && (startSec > 0 || endSec < (durationSec as number));

  const estimatedMinutes = hasKnownDuration
    ? processingMinutesFromSeconds(durationSec)
    : null;
  const minutesLeft = Math.max(0, usageSummary.limitMinutes - usageSummary.usedMinutes);

  const overUploadCap = hasKnownDuration && (durationSec as number) > usageSummary.maxUploadSeconds;
  const wouldExceedMonthly =
    hasKnownDuration &&
    isProcessingQuotaExceeded({
      usedMinutes: usageSummary.usedMinutes,
      requestedSeconds: durationSec,
      limitMinutes: usageSummary.limitMinutes,
      blockAtLimitWithoutRequest: true,
    });
  const planLimitMessage = overUploadCap
    ? // The per-upload cap is enforced against the full source duration
      // (sourceDurationSeconds), not the trimmed processing window — trimming
      // here cannot bring this under the cap, so the copy must not suggest it.
      `This video is about ${Math.round((durationSec as number) / 60)} min, over the ${Math.round(
        usageSummary.maxUploadSeconds / 60,
      )}-min per-upload limit on your plan. Upgrade for longer uploads.`
    : wouldExceedMonthly
      ? `This would put you over your monthly processing limit (${usageSummary.usedMinutes} of ${usageSummary.limitMinutes} min used).`
      : null;

  async function handleCommit() {
    setSubmitting(true);
    setErrorMessage(null);
    const processingStartSec = hasCustomWindow ? Math.floor(startSec) : null;
    const processingEndSec = hasCustomWindow ? Math.floor(endSec) : null;
    const result = await commitLinkImportAction({
      url: linkUrl,
      title: title.trim() || null,
      brandTemplateId,
      brandProfileId,
      commitToken,
      languageCode: languageCode === "auto" ? null : languageCode,
      mode,
      processingStartSec,
      processingEndSec,
    });
    if (!result.ok) {
      setErrorMessage(result.message);
      setSubmitting(false);
      return;
    }
    onCommitted({
      projectId: result.projectId,
      title: title.trim() || "Link Import",
      languageCode,
      mode,
      processingStartSec,
      processingEndSec,
    });
  }

  return (
    <Stack gap="6" maxW="640px" mx="auto" animation="fade-up">
      {/* Hidden YouTube IFrame duration probe — existing probe from
          video-preview.tsx, mounted off-screen so it never affects layout;
          the visible metadata card below draws its own thumbnail/title. */}
      {youtubeId && (
        <Box position="absolute" w="1px" h="1px" overflow="hidden" opacity="0" pointerEvents="none" aria-hidden>
          <VideoPreview
            source={{ kind: "link", url: linkUrl, provider: "youtube" }}
            onDurationKnown={handleDurationKnown}
            durationSec={durationSec}
          />
        </Box>
      )}

      <Flex align="center" justify="space-between">
        <Text textStyle="eyebrow" color="fg.subtle">
          Step 1 · Import
        </Text>
        <chakra.button
          type="button"
          onClick={onChangeSource}
          disabled={submitting}
          fontSize="12px"
          color="fg"
          textDecoration="underline"
          textUnderlineOffset="2px"
          cursor="pointer"
          transition="color 120ms ease"
          _hover={{ color: "fg.muted" }}
          _disabled={{ color: "fg.disabled", cursor: "not-allowed" }}
        >
          Change source
        </chakra.button>
      </Flex>

      {/* Metadata card */}
      <Box layerStyle="band">
        <Flex gap="4" align="flex-start">
          <MediaWell ratio={16 / 9} w={{ base: "120px", sm: "180px" }} flexShrink={0}>
            {youtubeId ? (
              <img
                src={youtubeThumbnailUrl(youtubeId, "hq")}
                alt=""
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            ) : (
              <Flex align="center" justify="center" position="absolute" inset="0" color="studio.fgMuted">
                <Link2 size={20} strokeWidth={1.75} />
              </Flex>
            )}
          </MediaWell>
          <Stack flex="1" minW="0" gap="2">
            <Text textStyle="eyebrow" color="fg.subtle">
              {linkProviderLabel(linkProvider)}
            </Text>
            <Input
              value={title}
              onChange={(event) => {
                titleTouchedRef.current = true;
                setTitle(event.target.value);
              }}
              placeholder="Episode 45 — Founder interview"
              aria-label="Project title"
              size="sm"
            />
            {youtubeId ? (
              <Popover.Root positioning={{ placement: "bottom-start" }}>
                <Popover.Trigger asChild>
                  <chakra.button
                    type="button"
                    display="inline-flex"
                    alignItems="center"
                    gap="1.5"
                    alignSelf="flex-start"
                    px="2.5"
                    py="1"
                    borderRadius="l1"
                    borderWidth="1px"
                    borderColor="border.control"
                    bg="bg.subtle"
                    cursor="pointer"
                    transition="border-color 120ms ease"
                    _hover={{ borderColor: "border.emphasized" }}
                  >
                    <Clock size={11} strokeWidth={1.75} />
                    <Text textStyle="data" fontSize="11px" color="fg">
                      {hasKnownDuration ? formatTimecode(durationSec as number) : "Detecting…"}
                    </Text>
                  </chakra.button>
                </Popover.Trigger>
                <Portal>
                  <Popover.Positioner>
                    <Popover.Content minW="320px" p="3">
                      <ProcessingTimeline
                        durationSec={durationSec}
                        startSec={startSec}
                        endSec={endSec}
                        disabled={!hasKnownDuration}
                        hasSource={true}
                        onChange={(s, e) => {
                          setStartSec(s);
                          setEndSec(e);
                        }}
                      />
                    </Popover.Content>
                  </Popover.Positioner>
                </Portal>
              </Popover.Root>
            ) : (
              <Text fontSize="11.5px" color="fg.muted" lineHeight="1.5">
                Details appear after import — the video is fetched and its
                duration detected during processing.
              </Text>
            )}
          </Stack>
        </Flex>
      </Box>

      {/* BrandTemplatePicker draws its own "Brand template" eyebrow + Manage link. */}
      <Box layerStyle="band">
        <BrandTemplatePicker
          builtIns={brandTemplates.builtIns}
          mine={brandTemplates.mine}
          value={brandTemplateId}
          onChange={setBrandTemplateId}
          profiles={brandProfiles.items}
          profileValue={brandProfileId}
          onProfileChange={setBrandProfileId}
        />
      </Box>

      <Flex gap="4" wrap="wrap">
        <Box flex="1" minW="180px">
          <Text textStyle="eyebrow" color="fg.subtle" mb="2">
            Speech language
          </Text>
          <LanguageSelect value={languageCode} onChange={setLanguageCode} />
        </Box>
        <Box flex="1" minW="180px">
          <Text textStyle="eyebrow" color="fg.subtle" mb="2">
            Mode
          </Text>
          <ModeTabs value={mode} onChange={setMode} />
        </Box>
      </Flex>

      <Stack gap="2.5">
        {planLimitMessage && <PlanLimitNotice message={planLimitMessage} />}
        {errorMessage && <ErrorNotice message={errorMessage} />}
        <Button
          onClick={handleCommit}
          disabled={submitting || overUploadCap || wouldExceedMonthly}
          type="button"
          size="sm"
        >
          {submitting ? (
            <>
              <Spinner size="xs" borderTopColor="accent.contrast" />
              <Text ms="1.5">Working…</Text>
            </>
          ) : (
            "Import & continue"
          )}
        </Button>
        <Text fontSize="11px" color="fg.subtle" textAlign="center">
          {hasKnownDuration
            ? `Counts ~${estimatedMinutes} min against your plan · ${minutesLeft} of ${usageSummary.limitMinutes} min left`
            : `Usage confirmed after import · ${minutesLeft} of ${usageSummary.limitMinutes} min left`}
        </Text>
      </Stack>
    </Stack>
  );
}
