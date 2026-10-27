"use client";

import { useState } from "react";
import { Flex, Input, Stack, Text, chakra } from "@chakra-ui/react";
import { Plus, Upload } from "lucide-react";
import type { AudioAssetKindInput } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { useAudioAssetList } from "@/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/audio-library";
import { AUDIO_UPLOAD_ACCEPT, AUDIO_UPLOAD_MAX_MB, uploadAudioFile } from "@/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/audio-upload";
import { formatDuration } from "@/lib/format";
import { putProfileMembership, useMembershipChange } from "./profile-membership";

const KINDS = [
  { label: "Music", value: "music" },
  { label: "Sound effects", value: "sfx" },
];

/** Opens the audio library (curated and the owner's own tracks) and attaches a track to the profile.
 *  Uploading a file adds it to the library and attaches it in one step, so an empty library is never a dead end. */
export function ProfileAudioPicker({
  profileId,
  attachedIds,
  nextPosition,
  label = "Add audio",
}: {
  profileId: string;
  attachedIds: string[];
  nextPosition: number;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button size="sm" variant="subtle" onClick={() => setOpen(true)}>
        <Plus size={13} /> {label}
      </Button>
    );
  }
  return <AudioLibraryList profileId={profileId} attachedIds={attachedIds} nextPosition={nextPosition} onClose={() => setOpen(false)} />;
}

function AudioLibraryList({
  profileId,
  attachedIds,
  nextPosition,
  onClose,
}: {
  profileId: string;
  attachedIds: string[];
  nextPosition: number;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<AudioAssetKindInput>("music");
  const [search, setSearch] = useState("");
  const { assets, loading, error, retry, hasMore, loadingMore, loadMore } = useAudioAssetList(kind, null, 0, { search });
  const { busy, run } = useMembershipChange("Could not add the audio");
  const rows = assets.filter((asset) => !attachedIds.includes(asset.id));
  const libraryEmpty = !search.trim() && assets.length === 0;
  const upload = (file: File) =>
    void run(async () => {
      const asset = await uploadAudioFile(file, kind);
      await putProfileMembership(profileId, { kind: "audio", resourceId: asset.id, position: nextPosition });
    });
  return (
    <Stack gap="4" bg="bg.soft" borderRadius="l3" p="5" w="full" maxW="xl" textAlign="left">
      <Flex gap="3" align="center" justify="space-between" flexWrap="wrap">
        <SegmentedControl items={KINDS} value={kind} onValueChange={(value) => setKind(value as AudioAssetKindInput)} />
        <Flex gap="2">
          <Button size="sm" variant="subtle" asChild loading={busy}>
            <chakra.label cursor="pointer">
              <Upload size={13} /> Upload {kind === "music" ? "music" : "a sound"}
              <chakra.input
                type="file"
                accept={AUDIO_UPLOAD_ACCEPT}
                disabled={busy}
                srOnly
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) upload(file);
                }}
              />
            </chakra.label>
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>
        </Flex>
      </Flex>
      <Input
        size="sm"
        aria-label="Search audio"
        placeholder="Search by title or mood"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
        bg="bg.panel"
        borderWidth="0"
        borderRadius="l2"
        _focusVisible={{ bg: "bg.muted", outline: "none" }}
      />
      {error ? (
        <Flex align="center" gap="3"><Text fontSize="13px" color="fg.muted">{error}</Text><Button size="xs" variant="subtle" onClick={retry}>Retry</Button></Flex>
      ) : loading ? (
        <Text fontSize="13px" color="fg.muted">Loading the audio library…</Text>
      ) : rows.length === 0 ? (
        <Text fontSize="13px" color="fg.muted">
          {search.trim()
            ? "No matching audio."
            : libraryEmpty
              ? `Your ${kind === "music" ? "music" : "sound effects"} library is empty. Upload an MP3, WAV or M4A up to ${AUDIO_UPLOAD_MAX_MB}MB.`
              : "Everything in your library is already in this profile."}
        </Text>
      ) : (
        <Stack gap="1">
          {rows.map((asset) => (
            <Flex key={asset.id} align="center" gap="4" py="2">
              <Stack gap="0" flex="1" minW="0">
                <Text fontSize="13px" fontWeight="500" lineClamp={1}>{asset.title}</Text>
                {asset.moodTags.length > 0 ? <Text fontSize="12px" color="fg.subtle" lineClamp={1}>{asset.moodTags.join(" · ")}</Text> : null}
              </Stack>
              <Text textStyle="data" color="fg.timecode">{formatDuration(asset.durationSec)}</Text>
              <Button
                size="xs"
                variant="subtle"
                aria-label={`Add ${asset.title}`}
                disabled={busy}
                onClick={() => void run(() => putProfileMembership(profileId, { kind: "audio", resourceId: asset.id, position: nextPosition }))}
              >
                Add
              </Button>
            </Flex>
          ))}
        </Stack>
      )}
      {hasMore ? <Button size="sm" variant="subtle" alignSelf="flex-start" loading={loadingMore} onClick={loadMore}>Load more</Button> : null}
    </Stack>
  );
}
