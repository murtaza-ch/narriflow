"use client";

import { useMemo, useState } from "react";
import { Box, Flex, Text, Stack, chakra } from "@chakra-ui/react";
import { AlertTriangle, Music2, Trash2, Upload as UploadIcon } from "lucide-react";
import { Spinner, toaster } from "@narriflow/ui";
import { AUDIO_UPLOAD_MAX_BYTES, type AudioAssetKindInput } from "@narriflow/validators";
import { formatDuration } from "@/lib/format";
import { useAudioAssetList, type AudioAssetListRow } from "./audio-library";

interface UploadsTabProps {
  reloadKey: number;
  onLibraryChange: () => void;
}

const EXTENSION_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

/** Browsers are inconsistent about `File.type` for audio (empty string for
 *  some .m4a files, "audio/x-m4a" vs "audio/mp4" for others) — fall back to
 *  the extension when the reported type isn't one the server accepts. */
function resolveContentType(file: File): string | null {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext ? EXTENSION_CONTENT_TYPE[ext] ?? null : null;
}

// L4: some files never fire EITHER `loadedmetadata` or `error` on a
// throwaway <audio> element (observed with a handful of oddly-muxed M4A
// files) — without a bound, `handleUpload` below would await this forever,
// leaving `uploading` stuck true and the whole panel unusable until reload.
const READ_AUDIO_DURATION_TIMEOUT_MS = 15_000;

/** Reads duration client-side via a throwaway `<audio>` element rather than
 *  sending the file to the server just to probe it — mirrors the client-side
 *  size/type pre-checks the B-roll custom-URL flow already does. Rejects
 *  after `READ_AUDIO_DURATION_TIMEOUT_MS` if neither event fires, which
 *  `handleUpload`'s existing try/catch already treats like any other upload
 *  failure (toast + reset `uploading`) — no separate error path needed. */
function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    const cleanup = () => {
      URL.revokeObjectURL(url);
      clearTimeout(timeoutId);
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Couldn't read this file's duration."));
    }, READ_AUDIO_DURATION_TIMEOUT_MS);
    audio.addEventListener("loadedmetadata", () => {
      resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
      cleanup();
    });
    audio.addEventListener("error", () => {
      resolve(0);
      cleanup();
    });
  });
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

function UploadRow({
  asset,
  deleting,
  onDelete,
}: {
  asset: AudioAssetListRow;
  deleting: boolean;
  onDelete: () => void;
}) {
  return (
    <Flex
      align="center"
      gap="8px"
      p="8px"
      borderRadius="l2"
      bg="studio.subtle"
      border="1px solid"
      borderColor="studio.border"
    >
      <Box color="studio.fgMuted" flexShrink={0}>
        <Music2 size={14} />
      </Box>
      <Stack gap="0" minW="0" flex="1">
        <Text fontSize="12px" color="studio.fg" fontWeight="500" truncate>
          {asset.title}
        </Text>
        <Text textStyle="data" fontSize="10.5px" color="studio.fgMuted" textTransform="capitalize">
          {asset.kind} · {formatDuration(asset.durationSec)}
        </Text>
      </Stack>
      <Box
        as="button"
        aria-label={`Delete ${asset.title}`}
        aria-disabled={deleting}
        color="studio.fgMuted"
        cursor={deleting ? "not-allowed" : "pointer"}
        opacity={deleting ? 0.5 : 1}
        flexShrink={0}
        _hover={deleting ? undefined : { color: "danger.400" }}
        transition="color 120ms ease, opacity 120ms ease"
        onClick={deleting ? undefined : onDelete}
      >
        {deleting ? <Spinner size="xs" /> : <Trash2 size={13} />}
      </Box>
    </Flex>
  );
}

export function UploadsTab({ reloadKey, onLibraryChange }: UploadsTabProps) {
  const [uploadKind, setUploadKind] = useState<AudioAssetKindInput>("music");
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const musicList = useAudioAssetList("music", null, reloadKey);
  const sfxList = useAudioAssetList("sfx", null, reloadKey);

  const myUploads = useMemo(
    () =>
      [...musicList.assets, ...sfxList.assets]
        .filter((asset) => asset.scope === "user")
        .sort((a, b) => a.title.localeCompare(b.title)),
    [musicList.assets, sfxList.assets],
  );

  async function handleUpload(file: File) {
    if (file.size > AUDIO_UPLOAD_MAX_BYTES) {
      toaster.create({
        type: "error",
        title: "File is too large",
        description: `Audio uploads are capped at ${Math.floor(AUDIO_UPLOAD_MAX_BYTES / (1024 * 1024))}MB.`,
      });
      return;
    }
    const contentType = resolveContentType(file);
    if (!contentType) {
      toaster.create({
        type: "error",
        title: "Unsupported file type",
        description: "Upload an MP3, WAV, or M4A file.",
      });
      return;
    }

    setUploading(true);
    try {
      const durationSec = await readAudioDuration(file);

      const presignRes = await fetch("/api/audio-assets/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType, sizeBytes: file.size }),
      });
      if (!presignRes.ok) {
        const body = await presignRes.json().catch(() => ({}));
        throw new Error(body.message ?? "Couldn't start the upload.");
      }
      const { key, uploadUrl, contentType: signedContentType } = (await presignRes.json()) as {
        key: string;
        uploadUrl: string;
        contentType: string;
      };

      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": signedContentType },
        body: file,
      });
      if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);

      const finalizeRes = await fetch("/api/audio-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          kind: uploadKind,
          title: stripExtension(file.name).slice(0, 120) || "Untitled",
          durationSec,
        }),
      });
      if (!finalizeRes.ok) {
        const body = await finalizeRes.json().catch(() => ({}));
        throw new Error(body.message ?? "Couldn't save the upload.");
      }

      toaster.create({ type: "success", title: "Uploaded" });
      onLibraryChange();
    } catch (error) {
      toaster.create({
        type: "error",
        title: "Upload failed",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(asset: AudioAssetListRow) {
    setDeletingId(asset.id);
    try {
      const res = await fetch(`/api/audio-assets/${asset.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      onLibraryChange();
    } catch {
      toaster.create({
        type: "error",
        title: "Couldn't delete",
        description: "Please try again.",
      });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Stack gap="14px" p="12px">
      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
          Upload as
        </Text>
        <Flex gap="6px">
          {(["music", "sfx"] as const).map((kind) => {
            const active = uploadKind === kind;
            return (
              <Flex
                key={kind}
                as="button"
                aria-pressed={active}
                align="center"
                justify="center"
                flex="1"
                h="28px"
                borderRadius="l2"
                bg={active ? "studio.raised" : "studio.subtle"}
                border="1px solid"
                borderColor={active ? "studio.accent" : "studio.border"}
                color={active ? "studio.accentFg" : "studio.fgMuted"}
                fontSize="11px"
                fontWeight="600"
                textTransform="capitalize"
                cursor="pointer"
                transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
                onClick={() => setUploadKind(kind)}
              >
                {kind === "sfx" ? "SFX" : "Music"}
              </Flex>
            );
          })}
        </Flex>
      </Box>

      <Box
        as="label"
        display="block"
        layerStyle="well"
        borderStyle="dashed"
        borderColor="border.control"
        p="16px"
        textAlign="center"
        cursor={uploading ? "not-allowed" : "pointer"}
        transition="border-color 120ms ease, background 120ms ease"
        _hover={uploading ? undefined : { borderColor: "border.emphasized" }}
      >
        <chakra.input
          type="file"
          accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a"
          disabled={uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleUpload(file);
          }}
          srOnly
        />
        <Flex direction="column" align="center" gap="6px">
          {uploading ? <Spinner size="sm" /> : <UploadIcon size={18} />}
          <Text fontSize="12px" color={uploading ? "fg.disabled" : "studio.fgMuted"}>
            {uploading ? "Uploading…" : "Upload MP3, WAV, or M4A"}
          </Text>
          <Text fontSize="10.5px" color="studio.fgSubtle">
            Up to {Math.floor(AUDIO_UPLOAD_MAX_BYTES / (1024 * 1024))}MB
          </Text>
        </Flex>
      </Box>

      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
          My uploads
        </Text>
        {musicList.loading || sfxList.loading ? (
          <Flex align="center" gap="8px" color="studio.fgMuted">
            <Spinner size="xs" />
            <Text fontSize="12px">Loading…</Text>
          </Flex>
        ) : musicList.error || sfxList.error ? (
          <Flex align="center" gap="6px" color="danger.400">
            <AlertTriangle size={12} />
            <Text fontSize="12px">Couldn&apos;t load your uploads.</Text>
          </Flex>
        ) : myUploads.length === 0 ? (
          <Text fontSize="12px" color="studio.fgMuted">
            Nothing uploaded yet.
          </Text>
        ) : (
          <Stack gap="6px">
            {myUploads.map((asset) => (
              <Box key={asset.id}>
                <UploadRow
                  asset={asset}
                  deleting={deletingId === asset.id}
                  onDelete={() => handleDelete(asset)}
                />
              </Box>
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
