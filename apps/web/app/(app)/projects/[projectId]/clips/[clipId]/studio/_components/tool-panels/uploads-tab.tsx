"use client";

import { useMemo, useState } from "react";
import { Box, Flex, Text, Stack, chakra } from "@chakra-ui/react";
import { chipProps } from "./panel-ui";
import { AlertTriangle, Music2, Trash2, Upload as UploadIcon } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import type { AudioAssetKindInput } from "@narriflow/validators";
import { formatDuration } from "@/lib/format";
import { useAudioAssetList, type AudioAssetListRow } from "./audio-library";
import { AUDIO_UPLOAD_ACCEPT, AUDIO_UPLOAD_MAX_MB, uploadAudioFile } from "./audio-upload";

interface UploadsTabProps {
  reloadKey: number;
  onLibraryChange: () => void;
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
      gap="10px"
      p="12px"
      borderRadius="10px"
      bg="studio.subtle"
    >
      <Box color="studio.fgMuted" flexShrink={0}>
        <Music2 size={16} />
      </Box>
      <Stack gap="0" minW="0" flex="1">
        <Text fontSize="13px" color="studio.fg" fontWeight="500" truncate>
          {asset.title}
        </Text>
        <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted" textTransform="capitalize">
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

  const musicList = useAudioAssetList("music", null, reloadKey, { scope: "user" });
  const sfxList = useAudioAssetList("sfx", null, reloadKey, { scope: "user" });

  const myUploads = useMemo(
    () =>
      [...musicList.assets, ...sfxList.assets]
        .filter((asset) => asset.scope === "user")
        .sort((a, b) => a.title.localeCompare(b.title)),
    [musicList.assets, sfxList.assets],
  );

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      await uploadAudioFile(file, uploadKind);
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
    <Stack gap="20px" px="20px" pt="16px" pb="16px">
      <Box>
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="6px">
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
                {...chipProps(active)}
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
        bg="studio.subtle"
        borderRadius="10px"
        borderWidth="1.5px"
        borderStyle="dashed"
        borderColor="studio.borderStrong"
        py="24px"
        px="16px"
        textAlign="center"
        cursor={uploading ? "not-allowed" : "pointer"}
        transition="border-color 120ms ease, background 120ms ease"
        _hover={uploading ? undefined : { bg: "studio.raised" }}
      >
        <chakra.input
          type="file"
          accept={AUDIO_UPLOAD_ACCEPT}
          disabled={uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleUpload(file);
          }}
          srOnly
        />
        <Flex direction="column" align="center" gap="8px" color="studio.fgMuted">
          {uploading ? <Spinner size="sm" /> : <UploadIcon size={20} />}
          <Text fontSize="13px" color={uploading ? "studio.fgSubtle" : "studio.fg"}>
            {uploading ? "Uploading…" : "Upload MP3, WAV, or M4A"}
          </Text>
          <Text fontSize="12px" color="studio.fgSubtle">
            Up to {AUDIO_UPLOAD_MAX_MB}MB
          </Text>
        </Flex>
      </Box>

      <Box>
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="6px">
          My uploads
        </Text>
        {musicList.loading || sfxList.loading ? (
          <Flex align="center" gap="8px" color="studio.fgMuted">
            <Spinner size="xs" />
            <Text fontSize="12px">Loading…</Text>
          </Flex>
        ) : musicList.error || sfxList.error ? (
          <Stack gap="6px" align="start" role="alert">
            <Flex align="center" gap="6px" color="studio.danger">
              <AlertTriangle size={12} />
              <Text fontSize="12px">Couldn&apos;t load your uploads.</Text>
            </Flex>
            <Flex as="button" minH="24px" px="8px" align="center" color="studio.fg" fontSize="13px" onClick={() => {
              if (musicList.error) musicList.retry();
              if (sfxList.error) sfxList.retry();
            }}>
              Retry
            </Flex>
          </Stack>
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
        {musicList.loadMoreError || sfxList.loadMoreError ? (
          <Stack align="start" gap="6px" role="alert" mt="8px">
            <Text fontSize="12px" color="studio.danger">Couldn't load more uploads.</Text>
            <Flex as="button" minH="24px" minW="24px" px="8px" align="center" fontSize="13px" onClick={() => {
              if (musicList.loadMoreError) musicList.loadMore();
              if (sfxList.loadMoreError) sfxList.loadMore();
            }}>Retry</Flex>
          </Stack>
        ) : musicList.hasMore || sfxList.hasMore ? (
          <Flex as="button" minH="32px" minW="24px" mt="8px" align="center" justify="center" fontSize="13px" aria-disabled={musicList.loadingMore || sfxList.loadingMore} onClick={musicList.loadingMore || sfxList.loadingMore ? undefined : () => {
            if (musicList.hasMore) musicList.loadMore();
            if (sfxList.hasMore) sfxList.loadMore();
          }}>
            {musicList.loadingMore || sfxList.loadingMore ? "Loading…" : "Load more"}
          </Flex>
        ) : null}
      </Box>
    </Stack>
  );
}
