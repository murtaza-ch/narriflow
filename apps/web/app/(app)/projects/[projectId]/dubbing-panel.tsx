"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Download, Mic2 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Select } from "@narriflow/ui/components/select";
import { Spinner } from "@narriflow/ui/components/spinner";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import type {
  ClipAspectRatio,
  ClipDubSnapshot,
  ClipSnapshot,
} from "@narriflow/validators";
import { userErrorMessage } from "@narriflow/validators";

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


const dubLabelColor: Record<ClipDubSnapshot["status"], string> = {
  completed: "success.fg",
  failed: "danger.fg",
  processing: "accent.fg",
  queued: "fg.muted",
};

export function DubbingPanel({
  projectId,
  clips,
  dubs,
}: {
  projectId: string;
  clips: ClipSnapshot[];
  dubs: ClipDubSnapshot[];
}) {
  const router = useRouter();
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
        const payload = (await response.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
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

  return (
    <Box layerStyle="band">
      <Stack gap="4">
        <Box>
          <Text textStyle="eyebrow" color="fg.subtle">
            Voiceover dubs
          </Text>
          <Text mt="0.5" fontSize="xs" color="fg.muted">
            Generate translated AI narration over completed clip renders.
          </Text>
        </Box>

        <Grid
          templateColumns={{
            base: "1fr",
            sm: "repeat(2, minmax(0, 1fr))",
            lg: "repeat(4, minmax(0, 1fr)) auto",
          }}
          gap="3"
          alignItems="end"
        >
          <Box>
            <Text textStyle="eyebrow" color="fg.subtle" mb="1">
              Clip
            </Text>
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
            <Text textStyle="eyebrow" color="fg.subtle" mb="1">
              Format
            </Text>
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
            <Text textStyle="eyebrow" color="fg.subtle" mb="1">
              Language
            </Text>
            <Select
              items={languageOptions}
              value={targetLanguageCode}
              onValueChange={setTargetLanguageCode}
              size="sm"
              aria-label="Target language"
            />
          </Box>

          <Box>
            <Text textStyle="eyebrow" color="fg.subtle" mb="1">
              Voice
            </Text>
            <Select
              items={voiceOptions}
              value={voice}
              onValueChange={setVoice}
              size="sm"
              aria-label="Voice"
            />
          </Box>

          <Button
            size="sm"
            disabled={
              isPending || submitting || !selectedClip || aspectRatios.length === 0
            }
            onClick={requestDub}
          >
            {isPending || submitting ? <Spinner size="xs" /> : <Mic2 size={14} />}
            <Text ms="1.5">
              {isPending || submitting ? "Queueing" : "Generate dub"}
            </Text>
          </Button>
        </Grid>

        {message ? (
          <Flex role="alert" align="center" gap="1.5" color="danger.fg">
            <AlertTriangle size={13} aria-hidden />
            <Text fontSize="xs">{message}</Text>
          </Flex>
        ) : null}

        {dubs.length > 0 ? (
          <Stack gap="3">
            {dubs.map((dub) => {
              const clipIndex = clips.find((clip) => clip.id === dub.clipId)?.index;
              return (
                <Flex
                  key={dub.id}
                  position="relative"
                  align="center"
                  justify="space-between"
                  gap="3"
                  p="4"
                  bg="bg.panel"
                  borderRadius="l2"
                  flexWrap="wrap"
                  transition="background 120ms ease"
                  _hover={{ bg: "bg.subtle" }}
                >
                  <Box minW="0">
                    <Text fontSize="13px" color="fg" truncate>
                      Clip {clipIndex === undefined ? "?" : clipIndex + 1} ·{" "}
                      {dub.targetLanguageCode.toUpperCase()} · {dub.voice} ·{" "}
                      <Text as="span" textStyle="data" fontSize="12px">
                        {dub.aspectRatio}
                      </Text>
                    </Text>
                    <Text
                      textStyle="eyebrow"
                      color={dubLabelColor[dub.status]}
                      truncate
                    >
                      {dub.status}
                      {dub.errorCode ? ` · ${userErrorMessage(dub.errorCode)}` : ""}
                    </Text>
                  </Box>
                  {dub.status === "completed" ? (
                    <Flex gap="1.5" flexShrink={0}>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={downloadingAsset !== null}
                        onClick={() => downloadDub(dub, "video")}
                      >
                        {downloadingAsset === `${dub.id}:video` ? (
                          <Spinner size="xs" />
                        ) : (
                          <Download size={12} />
                        )}
                        <Text ms="1">
                          {downloadingAsset === `${dub.id}:video`
                            ? "Preparing…"
                            : "Video"}
                        </Text>
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
                          <Download size={12} />
                        )}
                        <Text ms="1">
                          {downloadingAsset === `${dub.id}:audio`
                            ? "Preparing…"
                            : "Audio"}
                        </Text>
                      </Button>
                    </Flex>
                  ) : null}
                </Flex>
              );
            })}
          </Stack>
        ) : (
          <EmptyState
            icon={<Mic2 size={22} aria-hidden />}
            title="No dubs yet"
            description="Add translated narration to a rendered clip."
            ratio={9 / 16}
          />
        )}
      </Stack>
    </Box>
  );
}
