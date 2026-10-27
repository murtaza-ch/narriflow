"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, ArrowRight, Download, Languages, Mic2 } from "lucide-react";
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
import { userErrorMessage } from "@narriflow/validators";
import type { DubUsageSummary } from "@narriflow/services";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { useUpgrade, type UpgradePrompt } from "../../_components/upgrade";
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

function languageLabel(code: string) {
  return languageOptions.find((option) => option.value === code)?.label ?? code.toUpperCase();
}

function voiceLabel(value: string) {
  return voiceOptions.find((option) => option.value === value)?.label ?? value;
}

function FieldLabel({ children }: { children: string }) {
  return (
    <Text fontSize="12px" fontWeight="500" color="fg.muted" mb="1.5">
      {children}
    </Text>
  );
}

export function DubbingPanel({
  projectId,
  clips,
  dubs,
  allowance,
  planRequirement,
  upgrade,
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
            label: `Clip ${clip.index + 1}`,
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
        description="Translate a rendered clip and narrate it with an AI voice. Your original render doesn't change."
      />

      {/* Composer */}
      <Box
        bg="bg.panel"
        borderWidth="1px"
        borderColor="border.card"
        borderRadius="l3"
        overflow="hidden"
      >
        <Flex align="center" gap="2" px="5" pt="5">
          <Box color="fg.muted">
            <Mic2 size={16} aria-hidden />
          </Box>
          <Text fontSize="16px" fontWeight="500" color="fg">
            New dub
          </Text>
        </Flex>

        <Grid
          templateColumns={{
            base: "1fr",
            sm: "repeat(2, minmax(0, 1fr))",
            lg: "repeat(4, minmax(0, 1fr))",
          }}
          gap="4"
          p="5"
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

        <Flex
          align="center"
          justify="space-between"
          gap="3"
          wrap="wrap"
          px="5"
          pb="5"
        >
          {selectedClip ? (
            <Flex align="center" gap="2" fontSize="13px" color="fg.muted" minW="0">
              <Text color="fg">Clip {selectedClip.index + 1}</Text>
              <Text fontSize="12px" fontVariantNumeric="tabular-nums">
                {aspectRatio}
              </Text>
              <ArrowRight size={13} aria-hidden />
              <Text color="fg">{languageLabel(targetLanguageCode)}</Text>
              <Text>· {voiceLabel(voice)} voice</Text>
            </Flex>
          ) : (
            <Text fontSize="13px" color="fg.muted">
              Render a clip first. Dubs narrate over a finished render.
            </Text>
          )}
          <Flex align="center" gap="3">
            {allowance && !blockedMessage ? (
              <Text fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
                {allowance.remaining} of {allowance.limit} dubs left this month
              </Text>
            ) : null}
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
          </Flex>
        </Flex>
        {blockedMessage || clipTooLong ? (
          <Box px="5" pb="5" mt="-3">
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
      </Box>

      {message ? (
        <Flex
          role="alert"
          align="center"
          gap="2"
          color="danger.fg"
          borderStartWidth="3px"
          borderColor="danger.solid"
          ps="3"
          py="2"
        >
          <AlertTriangle size={14} aria-hidden />
          <Text fontSize="sm">{message}</Text>
        </Flex>
      ) : null}

      {dubs.length > 0 ? (
        <Box
          bg="bg.panel"
          borderWidth="1px"
          borderColor="border.card"
          borderRadius="l3"
          overflow="hidden"
        >
          {dubs.map((dub) => {
            const clipIndex = clips.find((clip) => clip.id === dub.clipId)?.index;
            return (
              <Flex
                key={dub.id}
                align="center"
                gap="4"
                px="5"
                py="3.5"
                borderBottomWidth="1px"
                borderColor="border.subtle"
                flexWrap="wrap"
                transition="background 120ms ease"
                _hover={{ bg: "bg.subtle" }}
                _last={{ borderBottomWidth: "0" }}
              >
                <Flex
                  boxSize="10"
                  flexShrink={0}
                  align="center"
                  justify="center"
                  borderRadius="full"
                  bg="bg.soft"
                  color="fg.muted"
                  fontSize="12px"
                  fontWeight="600"
                  aria-hidden="true"
                >
                  {dub.targetLanguageCode.toUpperCase()}
                </Flex>
                <Box minW="0" flex="1">
                  <Text fontSize="14px" fontWeight="550" color="fg" truncate>
                    {languageLabel(dub.targetLanguageCode)} · {voiceLabel(dub.voice)}
                  </Text>
                  <Text fontSize="12px" color="fg.subtle" truncate>
                    Clip {clipIndex === undefined ? "?" : clipIndex + 1} ·{" "}
                    <Text as="span" fontVariantNumeric="tabular-nums">
                      {dub.aspectRatio}
                    </Text>
                    {dub.errorCode ? (
                      <Text as="span" color="danger.fg">
                        {" "}
                        · {userErrorMessage(dub.errorCode)}
                      </Text>
                    ) : null}
                  </Text>
                </Box>
                {dub.status !== "completed" ? (
                  <StatusBadge status={dubBadgeStatus[dub.status]} label={dub.status} />
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
                      variant="ghost"
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
        </Box>
      ) : (
        <EmptyState
          icon={<Mic2 />}
          title="No dubs yet"
          description="Pick a rendered clip, choose a language and a voice, and generate. Each dub comes with a video and a narration-only audio file."
        />
      )}
    </Stack>
  );
}
