"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, chakra, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Music2, Trash2, Upload } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Select } from "@narriflow/ui/components/select";

type AudioAsset = {
  id: string;
  kind: "music" | "sfx";
  title: string;
  durationSec: number;
  playbackUrl: string;
};

function readDuration(file: File) {
  return new Promise<number>((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    audio.src = url;
  });
}

function supportedAudioContentType(file: File) {
  if (["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a"].includes(file.type)) {
    return file.type;
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "wav") return "audio/wav";
  if (extension === "m4a") return "audio/mp4";
  return file.type;
}

export function BrandAudioPanel({
  assets,
  canManage,
}: {
  assets: AudioAsset[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"music" | "sfx">("music");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !title.trim()) return;
    setFeedback(null);
    startTransition(async () => {
      try {
        const presign = await fetch("/api/audio-assets/presign-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contentType: supportedAudioContentType(file),
            sizeBytes: file.size,
          }),
        });
        const signed = (await presign.json()) as {
          key?: string;
          uploadUrl?: string;
          contentType?: string;
          message?: string;
        };
        if (!presign.ok || !signed.key || !signed.uploadUrl || !signed.contentType) {
          throw new Error(signed.message ?? "Could not prepare the upload");
        }
        const stored = await fetch(signed.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": signed.contentType },
          body: file,
        });
        if (!stored.ok) throw new Error("The audio file could not be uploaded");
        const durationSec = await readDuration(file);
        const finalized = await fetch("/api/audio-assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: signed.key,
            kind,
            title: title.trim(),
            durationSec,
          }),
        });
        const result = (await finalized.json()) as { message?: string };
        if (!finalized.ok) {
          throw new Error(result.message ?? "Could not add the audio asset");
        }
        setFile(null);
        setTitle("");
        setFeedback("Audio asset added to this workspace.");
        router.refresh();
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : "Upload failed");
      }
    });
  }

  function remove(assetId: string) {
    if (!window.confirm("Remove this audio asset from the workspace?")) return;
    setFeedback(null);
    startTransition(async () => {
      const response = await fetch(`/api/audio-assets/${assetId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        setFeedback(body.message ?? "Could not remove the audio asset");
        return;
      }
      router.refresh();
    });
  }

  return (
    <Stack gap="7">
      {canManage ? (
        <Stack as="form" onSubmit={upload} gap="3" borderTopWidth="1px" borderColor="border" pt="5">
          <Text fontSize="13px" fontWeight="600">Upload music or sound effects</Text>
          <Flex gap="3" direction={{ base: "column", md: "row" }} align={{ md: "flex-end" }}>
            <Stack gap="1" flex="1"><chakra.label htmlFor="brand-audio-file" textStyle="eyebrow" color="fg.subtle">Audio file</chakra.label><Input id="brand-audio-file" type="file" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a" onChange={(event) => { const next = event.target.files?.[0] ?? null; setFile(next); if (next && !title) setTitle(next.name.replace(/\.[^.]+$/, "")); }} required /></Stack>
            <Stack gap="1" flex="1"><chakra.label htmlFor="brand-audio-title" textStyle="eyebrow" color="fg.subtle">Title</chakra.label><Input id="brand-audio-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required /></Stack>
            <Stack gap="1"><chakra.label htmlFor="brand-audio-kind" textStyle="eyebrow" color="fg.subtle">Type</chakra.label><Select id="brand-audio-kind" ariaLabel="Audio type" value={kind} onValueChange={(value) => setKind(value as "music" | "sfx")} items={[{ value: "music", label: "Music" }, { value: "sfx", label: "Sound effect" }]} /></Stack>
            <Button type="submit" size="sm" disabled={pending || !file}>{pending ? <Spinner size="xs" /> : <Upload size={14} />}Upload</Button>
          </Flex>
          <Text fontSize="11px" color="fg.subtle">MP3, WAV, or M4A · maximum 50 MB</Text>
        </Stack>
      ) : null}

      {feedback ? <Text fontSize="12px" color="fg.muted">{feedback}</Text> : null}

      {assets.length === 0 ? (
        <Box py="10" textAlign="center" color="fg.muted"><Music2 size={20} style={{ margin: "0 auto 8px" }} /><Text fontSize="13px">No workspace audio assets yet.</Text></Box>
      ) : (
        <Stack gap="0" borderTopWidth="1px" borderColor="border">
          {assets.map((asset) => (
            <Flex key={asset.id} align={{ base: "flex-start", md: "center" }} direction={{ base: "column", md: "row" }} gap="3" py="4" borderBottomWidth="1px" borderColor="border.subtle">
              <Stack gap="0" minW="180px" flex="1"><Text fontSize="13px" fontWeight="600">{asset.title}</Text><Text textStyle="eyebrow" color="fg.subtle">{asset.kind === "music" ? "Music" : "Sound effect"} · {Math.round(asset.durationSec)}s</Text></Stack>
              <Box asChild w={{ base: "full", md: "280px" }}>
                {/* biome-ignore lint/a11y/useMediaCaption: Brand audio assets are music/SFX previews without spoken dialogue. */}
                <audio controls preload="none" src={asset.playbackUrl} aria-label={`Preview ${asset.title}`} />
              </Box>
              {canManage ? <Button size="xs" variant="ghost" aria-label={`Remove ${asset.title}`} onClick={() => remove(asset.id)} disabled={pending}><Trash2 size={13} /></Button> : null}
            </Flex>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
