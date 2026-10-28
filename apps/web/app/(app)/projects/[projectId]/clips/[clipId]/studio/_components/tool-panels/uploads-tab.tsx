"use client";

import { useMemo, useState } from "react";
import { Box, Flex, Text, Stack, chakra } from "@chakra-ui/react";
import { PanelSegmented, SectionLabel } from "./panel-ui";
import { Music2, Trash2, Upload as UploadIcon } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import type { AudioAssetKindInput } from "@narriflow/validators";
import { formatDuration } from "@/lib/format";
import { brandMutations } from "@narriflow/api-client/brand";
import { useAudioApi, useAudioAssetList, type AudioAssetListRow } from "./audio-library";
import { AUDIO_UPLOAD_ACCEPT, AUDIO_UPLOAD_MAX_MB, uploadAudioFile } from "./audio-upload";
import { AudioListError, AudioPager } from "./music-tab";

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
    <Flex align="center" gap="3" p="2" pe="3" borderRadius="12px" bg="studio.subtle">
      <Flex boxSize="36px" flexShrink={0} align="center" justify="center" borderRadius="8px" bg="studio.raised" color="studio.fgMuted">
        <Music2 size={15} />
      </Flex>
      <Stack gap="0" minW="0" flex="1">
        <Text fontSize="13px" color="studio.fg" fontWeight="500" truncate>
          {asset.title}
        </Text>
        <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted" textTransform="capitalize">
          {asset.kind} · {formatDuration(asset.durationSec)}
        </Text>
      </Stack>
      <Flex
        as="button"
        aria-label={`Delete ${asset.title}`}
        aria-disabled={deleting}
        minW="28px"
        minH="28px"
        align="center"
        justify="center"
        borderRadius="8px"
        color="studio.fgMuted"
        cursor={deleting ? "not-allowed" : "pointer"}
        opacity={deleting ? 0.5 : 1}
        flexShrink={0}
        _hover={deleting ? undefined : { bg: "studio.raised", color: "studio.danger" }}
        transition="color 120ms ease, background 120ms ease, opacity 120ms ease"
        onClick={deleting ? undefined : onDelete}
      >
        {deleting ? <Spinner size="xs" /> : <Trash2 size={14} />}
      </Flex>
    </Flex>
  );
}

export function UploadsTab({ reloadKey, onLibraryChange }: UploadsTabProps) {
  const [uploadKind, setUploadKind] = useState<AudioAssetKindInput>("music");
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const audioApi = useAudioApi();

  const musicList = useAudioAssetList("music", null, reloadKey, { scope: "user" });
  const sfxList = useAudioAssetList("sfx", null, reloadKey, { scope: "user" });

  const myUploads = useMemo(
    () =>
      [...musicList.assets, ...sfxList.assets]
        .filter((asset) => asset.scope === "user")
        .sort((a, b) => a.title.localeCompare(b.title)),
    [musicList.assets, sfxList.assets],
  );

  // A failed next page retries only the lists that failed; otherwise every list with more.
  const retryingPage = Boolean(musicList.loadMoreError || sfxList.loadMoreError);
  const pagedLists = [musicList, sfxList].filter((list) => (retryingPage ? list.loadMoreError : list.hasMore));

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      await uploadAudioFile(file, uploadKind, audioApi);
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
      if (!audioApi) throw new Error("Delete failed");
      await brandMutations(audioApi).deleteAudio(asset.id);
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
    <Stack gap="5" px="5" pt="4" pb="4">
      <Box>
        <SectionLabel>Upload as</SectionLabel>
        <PanelSegmented
          ariaLabel="Upload as"
          items={[{ value: "music", label: "Music" }, { value: "sfx", label: "SFX" }] as const}
          value={uploadKind}
          onChange={setUploadKind}
        />
      </Box>

      <Box
        as="label"
        display="block"
        bg="studio.subtle"
        borderRadius="12px"
        py="7"
        px="4"
        textAlign="center"
        cursor={uploading ? "not-allowed" : "pointer"}
        transition="background 120ms ease"
        _hover={uploading ? undefined : { bg: "studio.surface" }}
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
        <Flex direction="column" align="center" gap="1.5">
          <Flex boxSize="10" mb="1.5" align="center" justify="center" borderRadius="full" bg="studio.raised" color="studio.fgMuted">
            {uploading ? <Spinner size="sm" /> : <UploadIcon size={18} />}
          </Flex>
          <Text fontSize="14px" fontWeight="500" color={uploading ? "studio.fgSubtle" : "studio.fg"}>
            {uploading ? "Uploading…" : "Upload MP3, WAV, or M4A"}
          </Text>
          <Text fontSize="12.5px" color="studio.fgMuted">
            Up to {AUDIO_UPLOAD_MAX_MB}MB
          </Text>
        </Flex>
      </Box>

      <Box>
        <SectionLabel>My uploads</SectionLabel>
        <Stack gap="2">
          {musicList.loading || sfxList.loading ? (
            <Flex align="center" justify="center" gap="2" py="5" color="studio.fgMuted">
              <Spinner size="xs" />
              <Text fontSize="13px">Loading…</Text>
            </Flex>
          ) : musicList.error || sfxList.error ? (
            <AudioListError
              message="Couldn't load your uploads."
              onRetry={() => {
                if (musicList.error) musicList.retry();
                if (sfxList.error) sfxList.retry();
              }}
            />
          ) : myUploads.length === 0 ? (
            <Flex align="center" h="40px" px="3" bg="studio.subtle" borderRadius="12px" color="studio.fgSubtle" fontSize="13px">
              Nothing uploaded yet.
            </Flex>
          ) : (
            myUploads.map((asset) => (
              <UploadRow
                key={asset.id}
                asset={asset}
                deleting={deletingId === asset.id}
                onDelete={() => handleDelete(asset)}
              />
            ))
          )}
          <AudioPager
            error={retryingPage ? "Couldn't load more uploads." : null}
            hasMore={musicList.hasMore || sfxList.hasMore}
            loading={musicList.loadingMore || sfxList.loadingMore}
            onLoadMore={() => {
              for (const list of pagedLists) list.loadMore();
            }}
          />
        </Stack>
      </Box>
    </Stack>
  );
}
