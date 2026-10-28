"use client";

import { useMemo, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, ArrowRight, Download, Languages, Mic2, Play } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Select } from "@narriflow/ui/components/select";
import { Spinner } from "@narriflow/ui/components/spinner";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { PanelHeader } from "./panel-header";
import type {
  ClipAspectRatio,
  ClipDubSnapshot,
  ClipSnapshot,
} from "@narriflow/validators";
import { clipAspectRatioOptions, userErrorMessage } from "@narriflow/validators";
import type { DubUsageSummary } from "@narriflow/services";
import { formatDuration } from "@/lib/format";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { LockedButton, useUpgrade, type UpgradePrompt } from "../../_components/upgrade";
import { upgradePromptFromFailure, type BrowserRequestFailure } from "@/lib/authenticated-request-browser";

const languageOptions = [
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
  { value: "hi", label: "Hindi" },
  { value: "ur", label: "Urdu" },
  { value: "ja", label: "Japanese" },
  { value: "en", label: "English" },
];

const voiceOptions = [
  { value: "marin", label: "Marin" },
  { value: "cedar", label: "Cedar" },
  { value: "alloy", label: "Alloy" },
  { value: "coral", label: "Coral" },
  { value: "nova", label: "Nova" },
  { value: "shimmer", label: "Shimmer" },
];

function renderedAspectRatios(clip: ClipSnapshot): ClipAspectRatio[] {
  return clip.renderVariants
    .filter((render) => render.hasAsset)
    .map((render) => render.aspectRatio);
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function apiErrorCopy(payload: unknown, fallback: string): string {
  const errorCode = readPayloadString(payload, "error");
  return (
    userErrorMessage(errorCode) ??
    readPayloadString(payload, "message") ??
    fallback
  );
}

function downloadUrlFromPayload(payload: unknown): string | null {
  const value = readPayloadString(payload, "downloadUrl");
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}


const dubBadgeStatus: Record<
  ClipDubSnapshot["status"],
  "completed" | "failed" | "processing" | "pending"
> = {
  completed: "completed",
  failed: "failed",
  processing: "processing",
  queued: "pending",
};

const dubStatusLabel: Record<ClipDubSnapshot["status"], string> = {
  completed: "Completed",
  failed: "Failed",
  processing: "Processing",
  queued: "Queued",
};

/** The clip-tile gradients; a clip keeps the same one everywhere it appears. */
const CLIP_GRADIENTS = [
  "linear-gradient(140deg,#c1d2f2,#5c6c96)",
  "linear-gradient(135deg,#8cace0,#31486f)",
  "linear-gradient(140deg,#c9bcf0,#74619e)",
];

function languageLabel(code: string) {
  return languageOptions.find((option) => option.value === code)?.label ?? code.toUpperCase();
}

function voiceLabel(value: string) {
  return voiceOptions.find((option) => option.value === value)?.label ?? value;
}

/** "05 · Big screen, big drain"; a clip without a title is just "Clip 05". */
function clipLabel(clip: ClipSnapshot) {
  const number = String(clip.index + 1).padStart(2, "0");
  return clip.title ? `${number} · ${clip.title}` : `Clip ${number}`;
}

function FieldLabel({ children }: { children: string }) {
  return (
    <Text fontSize="12px" fontWeight="500" color="fg.muted" mb="1.5">
      {children}
    </Text>
  );
}

/** A clip drawn in its own shape, 44px on its longest side, centered in a square slot. */
function ClipTile({
  ratio,
  gradientIndex,
  children,
}: {
  ratio: ClipAspectRatio;
  gradientIndex: number;
  children?: ReactNode;
}) {
  const option = clipAspectRatioOptions.find((candidate) => candidate.value === ratio);
  const longest = option ? Math.max(option.iconW, option.iconH) : 16;
  const width = option ? (option.iconW / longest) * 44 : 25;
  const height = option ? (option.iconH / longest) * 44 : 44;
  return (
    <Flex boxSize="44px" flexShrink={0} align="center" justify="center" aria-hidden="true">
      <Flex
        w={`${width}px`}
        h={`${height}px`}
        align="center"
        justify="center"
        borderRadius="l1"
        background={CLIP_GRADIENTS[gradientIndex % CLIP_GRADIENTS.length]}
        color="white"
      >
        {children}
      </Flex>
    </Flex>
  );
}

const WAVEFORM = [5, 10, 7, 13, 8, 11, 6];

/** A small waveform glyph that marks a voice. */
function Waveform() {
  return (
    <Flex align="center" gap="1.5px" h="14px" flexShrink={0} aria-hidden="true">
      {WAVEFORM.map((height, index) => (
        <Box key={index} w="2px" h={`${height}px`} borderRadius="full" bg="accent.solid" />
      ))}
    </Flex>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <Flex align="center" gap="2" px="3" h="8" borderRadius="full" bg="bg.soft" fontSize="13px" color="fg" flexShrink={0}>
      {children}
    </Flex>
  );
}

/** Small meter for the month's dubs: how much of the allowance is left. */
function AllowanceMeter({ remaining, limit }: { remaining: number; limit: number }) {
  const percent = limit > 0 ? Math.min(100, Math.max(0, (remaining / limit) * 100)) : 0;
  return (
    <Stack gap="1.5" minW="150px">
      <Text fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
        {`${remaining} of ${limit} left this month`}
      </Text>
      <Box
        role="meter"
        aria-label="Dubs left this month"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={remaining}
        h="6px"
        bg="bg.soft"
        borderRadius="full"
        overflow="hidden"
      >
        <Box h="full" w={`${percent}%`} bg="accent.solid" borderRadius="full" transition="width 200ms ease" />
      </Box>
    </Stack>
  );
}

/** What a dub produces, drawn: a dubbed video and a narration-only audio file. */
function DubsEmpty({ canEdit }: { canEdit: boolean }) {
  return (
    <Flex align="center" gap="5" bg="bg.subtle" borderRadius="l3" px={{ base: "5", md: "6" }} py="5" wrap="wrap">
      <Flex align="center" gap="3" aria-hidden="true">
        <ClipTile ratio="9:16" gradientIndex={0}>
          <Play size={12} fill="currentColor" strokeWidth={0} />
        </ClipTile>
        <Flex align="center" h="10" px="3.5" borderRadius="full" bg="bg.soft">
          <Waveform />
        </Flex>
      </Flex>
      <Box minW="0" flex="1">
        <Text fontSize="14px" fontWeight="550" color="fg">
          No dubs yet
        </Text>
        <Text fontSize="13px" color="fg.muted">
          {canEdit
            ? "Each dub comes with a video and a narration-only audio file."
            : "Voiceover dubs made from this project's clips show up here."}
        </Text>
      </Box>
    </Flex>
  );
}

export function DubbingPanel({
  projectId,
  clips,
  dubs,
  allowance,
  planRequirement,
  upgrade,
  canEdit,
}: {
  projectId: string;
  clips: ClipSnapshot[];
  dubs: ClipDubSnapshot[];
  /** This month's dub allowance; `null` while unavailable. */
  allowance: DubUsageSummary | null;
  /** Why the plan can't dub, computed server-side; `null` when it can. */
  planRequirement: string | null;
  /** What an upgrade would add; `null` when no plan lifts the block (top-tier allowance: it renews). */
  upgrade: UpgradePrompt | null;
  /** Role and workspace status allow new dubs; otherwise only finished dubs show. */
  canEdit: boolean;
}) {
  const router = useRouter();
  const { openUpgrade } = useUpgrade();
  const [isPending, startTransition] = useTransition();
  const renderedClips = useMemo(
    () => clips.filter((clip) => renderedAspectRatios(clip).length > 0),
    [clips],
  );
  const [clipId, setClipId] = useState(renderedClips[0]?.id ?? "");
  const selectedClip = renderedClips.find((clip) => clip.id === clipId) ?? null;
  const aspectRatios = selectedClip ? renderedAspectRatios(selectedClip) : [];
  const [aspectRatio, setAspectRatio] = useState<ClipAspectRatio>(
    aspectRatios[0] ?? "9:16",
  );
  const [targetLanguageCode, setTargetLanguageCode] = useState("es");
  const [voice, setVoice] = useState("marin");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [downloadingAsset, setDownloadingAsset] = useState<string | null>(null);

  const clipItems = useMemo(
    () =>
      renderedClips.length === 0
        ? [{ value: "", label: "No rendered clips", disabled: true }]
        : renderedClips.map((clip) => ({
            value: clip.id,
            label: clipLabel(clip),
          })),
    [renderedClips],
  );
  const aspectRatioItems = aspectRatios.map((value) => ({
    value,
    label: value,
  }));

  async function requestDub() {
    if (submitting) {
      return;
    }
    if (!selectedClip) {
      setMessage("Render a clip before generating a dub.");
      return;
    }

    setMessage(null);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/dubs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          clipId: selectedClip.id,
          aspectRatio,
          targetLanguageCode,
          voice,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as BrowserRequestFailure | null;
        if (response.status === 402 && payload) {
          const prompt = upgradePromptFromFailure(payload);
          if (prompt) openUpgrade(prompt);
        }
        setMessage(
          payload?.message ??
            userErrorMessage(payload?.error) ??
            "Could not queue dub.",
        );
        return;
      }

      startTransition(() => router.refresh());
    } catch (err) {
      console.warn(JSON.stringify({ level: "error", message: "request_dub_failed", errorName: err instanceof Error ? err.name : "UnknownError" }));
      setMessage("Could not queue dub. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function downloadDub(dub: ClipDubSnapshot, asset: "video" | "audio") {
    if (downloadingAsset) return;

    const downloadKey = `${dub.id}:${asset}`;
    setDownloadingAsset(downloadKey);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/dubs/${dub.id}/download?asset=${asset}`,
      );
      const payload: unknown = await response.json().catch(() => null);
      const downloadUrl = downloadUrlFromPayload(payload);
      if (!response.ok || !downloadUrl) {
        console.warn(JSON.stringify({ level: "error", message: "dub_download_failed", status: response.status }));
        setMessage(
          apiErrorCopy(payload, "Could not prepare this download. Please try again."),
        );
        return;
      }

      window.location.assign(downloadUrl);
    } catch {
      console.warn(JSON.stringify({ level: "error", message: "dub_download_failed" }));
      setMessage("Could not prepare this download. Please try again.");
    } finally {
      setDownloadingAsset((current) =>
        current === downloadKey ? null : current,
      );
    }
  }

  const busy = isPending || submitting;
  // Show the plan boundary before the user fills in the form, not after.
  const renewsOn = allowance?.renewsAt
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
        new Date(allowance.renewsAt),
      )
    : null;
  const blockedMessage =
    planRequirement ??
    (allowance && allowance.remaining <= 0
      ? `This workspace has used its ${allowance.limit} dubs for this month.${renewsOn ? ` They renew on ${renewsOn} (UTC).` : ""}`
      : null);
  const clipTooLong =
    !blockedMessage &&
    allowance !== null &&
    selectedClip !== null &&
    allowance.maxClipSeconds > 0 &&
    selectedClip.durationSec > allowance.maxClipSeconds;

  return (
    <Stack gap="6">
      <PanelHeader
        icon={<Languages size={20} />}
        title="Voiceover dubs"
        description="Narrate a rendered clip in another language with an AI voice."
      />

      {/* Composer */}
      {canEdit ? (
        <Stack gap="5" bg="bg.subtle" borderRadius="l3" p={{ base: "5", md: "6" }}>
          <Grid
            templateColumns={{
              base: "1fr",
              sm: "repeat(2, minmax(0, 1fr))",
              lg: "minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1.3fr)",
            }}
            gap="4"
          >
            <Box>
              <FieldLabel>Clip</FieldLabel>
              <Select
                items={clipItems}
                value={clipId}
                onValueChange={(nextId) => {
                  setClipId(nextId);
                  const nextClip = renderedClips.find((clip) => clip.id === nextId);
                  const nextAspect = nextClip
                    ? renderedAspectRatios(nextClip)[0]
                    : null;
                  if (nextAspect) setAspectRatio(nextAspect);
                }}
                size="sm"
                placeholder="No rendered clips"
                disabled={renderedClips.length === 0}
                aria-label="Clip to dub"
              />
            </Box>

            <Box>
              <FieldLabel>Format</FieldLabel>
              <Select
                items={aspectRatioItems}
                value={aspectRatio}
                onValueChange={(value) => setAspectRatio(value as ClipAspectRatio)}
                size="sm"
                placeholder="Format"
                disabled={aspectRatios.length === 0}
                aria-label="Render format"
              />
            </Box>

            <Box>
              <FieldLabel>Language</FieldLabel>
              <Select
                items={languageOptions}
                value={targetLanguageCode}
                onValueChange={setTargetLanguageCode}
                size="sm"
                aria-label="Target language"
              />
            </Box>

            <Box>
              <FieldLabel>Voice</FieldLabel>
              <Select
                items={voiceOptions}
                value={voice}
                onValueChange={setVoice}
                size="sm"
                aria-label="Voice"
              />
            </Box>
          </Grid>

          <Flex align="center" justify="space-between" gap="4" wrap="wrap">
            {selectedClip ? (
              <Flex
                align="center"
                gap="3"
                wrap="wrap"
                flex="1 1 380px"
                minW="0"
                bg="bg.panel"
                borderRadius="l2"
                px="3"
                py="2.5"
              >
                <Flex align="center" gap="2.5" minW="0">
                  <ClipTile ratio={aspectRatio} gradientIndex={selectedClip.index}>
                    <Play size={12} fill="currentColor" strokeWidth={0} />
                  </ClipTile>
                  <Box minW="0">
                    <Text fontSize="13px" fontWeight="550" color="fg" truncate maxW="240px">
                      {clipLabel(selectedClip)}
                    </Text>
                    <Text textStyle="data" fontSize="11px" color="fg.subtle">
                      {`${aspectRatio} · ${formatDuration(selectedClip.durationSec)}`}
                    </Text>
                  </Box>
                </Flex>
                <Box color="fg.subtle" aria-hidden="true">
                  <ArrowRight size={14} />
                </Box>
                <Chip>
                  <Text as="span" textStyle="data" fontSize="10px" color="accent.fg">
                    {targetLanguageCode.toUpperCase()}
                  </Text>
                  {languageLabel(targetLanguageCode)}
                </Chip>
                <Box color="fg.subtle" aria-hidden="true">
                  <ArrowRight size={14} />
                </Box>
                <Chip>
                  <Waveform />
                  {voiceLabel(voice)}
                </Chip>
              </Flex>
            ) : (
              <Text fontSize="13px" color="fg.muted">
                Render a clip first. Dubs narrate over a finished render.{" "}
                <Link href={`/projects/${projectId}`} style={{ textDecoration: "underline", textUnderlineOffset: "3px" }}>
                  Go to clips
                </Link>
              </Text>
            )}
            <Flex align="center" gap="4" ms="auto">
              {allowance && !blockedMessage ? (
                <AllowanceMeter remaining={allowance.remaining} limit={allowance.limit} />
              ) : null}
              {blockedMessage && upgrade?.tier ? (
                // A plan lock stays clickable and explains the upgrade, like every other locked action.
                <LockedButton size="sm" prompt={upgrade}>
                  <Mic2 size={14} />
                  Generate dub
                </LockedButton>
              ) : (
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    !selectedClip ||
                    aspectRatios.length === 0 ||
                    blockedMessage !== null ||
                    clipTooLong
                  }
                  onClick={requestDub}
                >
                  {busy ? <Spinner size="xs" /> : <Mic2 size={14} />}
                  {busy ? "Queueing" : "Generate dub"}
                </Button>
              )}
            </Flex>
          </Flex>
          {blockedMessage || clipTooLong ? (
            <Box mt="-2">
              {blockedMessage ? (
                <PlanLimitNotice message={blockedMessage} upgrade={upgrade} />
              ) : (
                <Text fontSize="xs" color="warning.fg">
                  Dubs work on clips up to {Math.round((allowance?.maxClipSeconds ?? 0) / 60)} minutes. Trim this clip
                  first.
                </Text>
              )}
            </Box>
          ) : null}
        </Stack>
      ) : null}

      {message ? (
        <Flex
          role="alert"
          align="center"
          gap="2.5"
          bg="danger.subtle"
          color="danger.fg"
          borderRadius="l2"
          px="4"
          py="3"
        >
          <AlertTriangle size={15} aria-hidden />
          <Text fontSize="13px">{message}</Text>
        </Flex>
      ) : null}

      {dubs.length > 0 ? (
        <Stack gap="2">
          {dubs.map((dub) => {
            const clip = clips.find((candidate) => candidate.id === dub.clipId);
            return (
              <Flex
                key={dub.id}
                align="center"
                gap="4"
                px="4"
                py="3"
                bg="bg.subtle"
                borderRadius="l3"
                flexWrap="wrap"
                transition="background 120ms ease"
                _hover={{ bg: "bg.muted" }}
              >
                <ClipTile ratio={dub.aspectRatio} gradientIndex={clip?.index ?? 0}>
                  <Text fontSize="10px" fontWeight="600" lineHeight="1">
                    {dub.targetLanguageCode.toUpperCase()}
                  </Text>
                </ClipTile>
                <Box minW="0" flex="1">
                  <Flex align="center" gap="2.5" minW="0">
                    <Text fontSize="14px" fontWeight="550" color="fg" truncate>
                      {languageLabel(dub.targetLanguageCode)}
                    </Text>
                    <Flex align="center" gap="1.5" fontSize="13px" color="fg.muted" flexShrink={0}>
                      <Waveform />
                      {voiceLabel(dub.voice)}
                    </Flex>
                  </Flex>
                  <Text fontSize="12px" color="fg.subtle" truncate>
                    {clip ? clipLabel(clip) : "Clip"} ·{" "}
                    <Text as="span" fontVariantNumeric="tabular-nums">
                      {dub.aspectRatio}
                    </Text>
                    {dub.status === "completed" && dub.durationSec !== null ? (
                      <Text as="span" textStyle="data">
                        {" "}
                        · {formatDuration(dub.durationSec)}
                      </Text>
                    ) : null}
                    {dub.errorCode ? (
                      <Text as="span" color="danger.fg">
                        {" "}
                        · {userErrorMessage(dub.errorCode)}
                      </Text>
                    ) : null}
                  </Text>
                </Box>
                {dub.status !== "completed" ? (
                  <StatusBadge status={dubBadgeStatus[dub.status]} label={dubStatusLabel[dub.status]} />
                ) : null}
                {dub.status === "completed" ? (
                  <Flex gap="1.5" flexShrink={0}>
                    <Button
                      size="sm"
                      variant="subtle"
                      disabled={downloadingAsset !== null}
                      onClick={() => downloadDub(dub, "video")}
                    >
                      {downloadingAsset === `${dub.id}:video` ? (
                        <Spinner size="xs" />
                      ) : (
                        <Download size={13} />
                      )}
                      {downloadingAsset === `${dub.id}:video` ? "Preparing…" : "Video"}
                    </Button>
                    <Button
                      size="sm"
                      variant="subtle"
                      disabled={downloadingAsset !== null}
                      onClick={() => downloadDub(dub, "audio")}
                    >
                      {downloadingAsset === `${dub.id}:audio` ? (
                        <Spinner size="xs" />
                      ) : (
                        <Download size={13} />
                      )}
                      {downloadingAsset === `${dub.id}:audio` ? "Preparing…" : "Audio"}
                    </Button>
                  </Flex>
                ) : null}
              </Flex>
            );
          })}
        </Stack>
      ) : (
        <DubsEmpty canEdit={canEdit} />
      )}
    </Stack>
  );
}
