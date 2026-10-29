"use client";

import { useState } from "react";
import { Flex, Input, Stack, Text, chakra } from "@chakra-ui/react";
import { Check, Plus, Search, Upload } from "lucide-react";
import type { AudioAssetKindInput } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { Dialog, Portal } from "@narriflow/ui/components/dialog";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { AUDIO_UPLOAD_ACCEPT, AUDIO_UPLOAD_MAX_MB } from "@/lib/audio-upload";
import { formatDuration } from "@/lib/format";
import { useAudioLibrary, useAudioUpload } from "./profile-audio-library";
import { useMembershipChange } from "./profile-membership";
import { PlayButton, useAudioPreview } from "./profile-audio-list";

const KINDS = [
  { label: "Music", value: "music" },
  { label: "Sound effects", value: "sfx" },
];

/** Opens the audio library (curated and the owner's own tracks) and attaches tracks to the profile.
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
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus size={14} /> {label}
      </Button>
      <Dialog.Root open={open} onOpenChange={(details) => setOpen(details.open)} placement="center" size="lg">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="xl">
              <Dialog.Header>
                <Dialog.Title>Add audio</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {open ? <AudioLibraryList profileId={profileId} attachedIds={attachedIds} nextPosition={nextPosition} /> : null}
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="subtle" onClick={() => setOpen(false)}>Done</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

function AudioLibraryList({
  profileId,
  attachedIds,
  nextPosition,
}: {
  profileId: string;
  attachedIds: string[];
  nextPosition: number;
}) {
  const [kind, setKind] = useState<AudioAssetKindInput>("music");
  const [search, setSearch] = useState("");
  const { assets, loading, error, retry, hasMore, loadingMore, loadMore } = useAudioLibrary(kind, search);
  const uploadAudioFile = useAudioUpload();
  const { busy, run, put } = useMembershipChange("Could not add the audio");
  const preview = useAudioPreview();
  const libraryEmpty = !search.trim() && assets.length === 0;
  const upload = (file: File) =>
    void run(async () => {
      const asset = await uploadAudioFile(file, kind);
      await put(profileId, { kind: "audio", resourceId: asset.id, position: nextPosition });
    });
  return (
    <Stack gap="4">
      <Flex gap="3" align="center" justify="space-between" flexWrap="wrap">
        <SegmentedControl items={KINDS} value={kind} onValueChange={(value) => setKind(value as AudioAssetKindInput)} />
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
      </Flex>
      <Flex align="center" gap="2" px="3" bg="bg.soft" borderRadius="control" color="fg.muted" _focusWithin={{ boxShadow: "inset 0 0 0 1px var(--chakra-colors-border-focus)" }}>
        <Search size={14} />
        <Input
          size="sm"
          aria-label="Search audio"
          placeholder="Search by title or mood"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          bg="transparent"
          px="0"
          _hover={{ bg: "transparent" }}
          _focus={{ borderColor: "transparent" }}
          _focusVisible={{ borderColor: "transparent" }}
        />
      </Flex>
      <Stack gap="1" minH="240px" maxH="360px" overflowY="auto" mx="-2" px="2">
        {error ? (
          <Flex align="center" gap="3"><Text fontSize="13px" color="fg.muted">{error}</Text><Button size="xs" variant="subtle" onClick={retry}>Retry</Button></Flex>
        ) : loading ? (
          <Text fontSize="13px" color="fg.muted">Loading the audio library…</Text>
        ) : assets.length === 0 ? (
          <Text fontSize="13px" color="fg.muted">
            {libraryEmpty
              ? `Your ${kind === "music" ? "music" : "sound effects"} library is empty. Upload an MP3, WAV or M4A up to ${AUDIO_UPLOAD_MAX_MB}MB.`
              : "No matching audio."}
          </Text>
        ) : (
          assets.map((asset) => {
            const attached = attachedIds.includes(asset.id);
            return (
              <Flex key={asset.id} align="center" gap="3" py="2" px="2" borderRadius="l2" _hover={{ bg: "bg.soft" }}>
                <PlayButton id={asset.id} title={asset.title} preview={preview} />
                <Stack gap="0" flex="1" minW="0">
                  <Text fontSize="13px" fontWeight="500" lineClamp={1}>{asset.title}</Text>
                  {asset.moodTags.length > 0 ? <Text fontSize="12px" color="fg.subtle" lineClamp={1}>{asset.moodTags.join(" · ")}</Text> : null}
                </Stack>
                <Text textStyle="data" fontSize="12px" color="fg.timecode">{formatDuration(asset.durationSec)}</Text>
                {attached ? (
                  <Flex align="center" gap="1" h="8" px="2.5" fontSize="12px" fontWeight="500" color="accent.fg">
                    <Check size={13} /> Added
                  </Flex>
                ) : (
                  <Button
                    size="xs"
                    variant="subtle"
                    aria-label={`Add ${asset.title}`}
                    disabled={busy}
                    onClick={() => void run(() => put(profileId, { kind: "audio", resourceId: asset.id, position: nextPosition }))}
                  >
                    Add
                  </Button>
                )}
              </Flex>
            );
          })
        )}
        {hasMore ? <Button size="sm" variant="subtle" alignSelf="flex-start" loading={loadingMore} onClick={loadMore}>Load more</Button> : null}
      </Stack>
    </Stack>
  );
}
