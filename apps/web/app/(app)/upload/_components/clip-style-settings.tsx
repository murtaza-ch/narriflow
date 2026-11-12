"use client";

import { Box, chakra, Field, Flex, Stack, Text } from "@chakra-ui/react";
import { AudioLines, Info, MessageSquareOff, Zap } from "lucide-react";
import { Switch } from "@narriflow/ui/components/switch";
import { Textarea } from "@narriflow/ui/components/textarea";
import type {
  CaptionPresetId,
  ClipLengthPreset,
  ClipPlatformTarget,
  ContentPack,
  GenerationMode,
} from "@narriflow/validators";
import { AdvancedSettings } from "./advanced-settings";
import { FormatSettings } from "./format-settings";
import { CaptionPresetGallery } from "../../_shared/caption-preset-gallery";
import { MomentSuggestions } from "../../_shared/moment-suggestions";

export interface ClipStyleSettingsProps {
  mode: GenerationMode;
  defaultAspectRatio: ContentPack["defaultAspectRatio"];
  setDefaultAspectRatio: (value: ContentPack["defaultAspectRatio"]) => void;
  clipLengthPreset: ClipLengthPreset;
  setClipLengthPreset: (value: ClipLengthPreset) => void;
  captionPreset: CaptionPresetId;
  setCaptionPreset: (value: CaptionPresetId) => void;
  autoHook: boolean;
  setAutoHook: (value: boolean) => void;
  removeSilences: boolean;
  setRemoveSilences: (value: boolean) => void;
  removeFillerWords: boolean;
  setRemoveFillerWords: (value: boolean) => void;
  specificMoments: string;
  setSpecificMoments: (value: string) => void;
  platformTargets: ClipPlatformTarget[];
  setPlatformTargets: (value: ClipPlatformTarget[]) => void;
  clipCountTarget: number;
  setClipCountTarget: (value: number) => void;
  toneConstraints: string;
  setToneConstraints: (value: string) => void;
}

export function ClipStyleSettings({
  mode,
  defaultAspectRatio,
  setDefaultAspectRatio,
  clipLengthPreset,
  setClipLengthPreset,
  captionPreset,
  setCaptionPreset,
  autoHook,
  setAutoHook,
  removeSilences,
  setRemoveSilences,
  removeFillerWords,
  setRemoveFillerWords,
  specificMoments,
  setSpecificMoments,
  platformTargets,
  setPlatformTargets,
  clipCountTarget,
  setClipCountTarget,
  toneConstraints,
  setToneConstraints,
}: ClipStyleSettingsProps) {
  return (
    <Stack
      gap="5"
      bg="bg.panel"
      borderRadius="l3"
      borderWidth="1px"
      borderColor="border.card"
      p={{ base: "4", md: "5" }}
    >
      <FormatSettings
        aspectRatio={defaultAspectRatio}
        onAspectRatioChange={setDefaultAspectRatio}
        clipLength={clipLengthPreset}
        onClipLengthChange={setClipLengthPreset}
        showClipLength={mode === "clip"}
      />
      <CaptionPresetGallery value={captionPreset} onChange={setCaptionPreset} />
      {mode === "clip" ? (
        <Stack gap="2">
          {[
            { id: "auto-hook-label", name: "autoHook", icon: <Zap size={16} strokeWidth={1.75} aria-hidden="true" />, title: "Start with a hook", hint: "Prefer clips that open on an attention-grabbing line", checked: autoHook, onChange: setAutoHook },
            { id: "remove-silences-label", name: "removeSilences", icon: <AudioLines size={16} strokeWidth={1.75} aria-hidden="true" />, title: "Remove silences", hint: "Cuts pauses where the audio is quiet", checked: removeSilences, onChange: setRemoveSilences },
            { id: "remove-filler-words-label", name: "removeFillerWords", icon: <MessageSquareOff size={16} strokeWidth={1.75} aria-hidden="true" />, title: "Remove filler words", hint: "Cuts um, uh and similar sounds", checked: removeFillerWords, onChange: setRemoveFillerWords },
          ].map((row) => (
            // The same row as the import card's "Get AI clips": icon, what it does, a switch.
            <Flex key={row.name} align="center" gap="2.5" minH="52px" px="3" py="2" bg="bg.soft" borderRadius="l2">
              {row.icon}
              <Box flex="1" minW="0">
                <Text id={row.id} fontSize="14px">
                  {row.title}
                </Text>
                <Text fontSize="12px" color="fg.muted">
                  {row.hint}
                </Text>
              </Box>
              <Switch
                checked={row.checked}
                onCheckedChange={row.onChange}
                inputProps={{ name: row.name, "aria-labelledby": row.id }}
              />
            </Flex>
          ))}
        </Stack>
      ) : (
        <Flex
          gap="2"
          align="center"
          bg="bg.soft"
          borderRadius="l2"
          p="4"
          color="fg.muted"
        >
          <Info size={16} />
          <Text fontSize="13px">
            Your full video will be transcribed and rendered with captions.
          </Text>
        </Flex>
      )}
      {mode === "clip" && (
        <>
          <Field.Root>
            <Flex justify="space-between" align="center" w="full">
              <Field.Label fontSize="13px" fontWeight="500">
                Find a specific moment{" "}
                <chakra.span fontWeight="400" color="fg.subtle" ml="1">
                  Optional
                </chakra.span>
              </Field.Label>
              {specificMoments.length > 0 ? (
                <Text
                  fontSize="12px"
                  color="fg.subtle"
                  fontVariantNumeric="tabular-nums"
                >
                  {specificMoments.length}/500
                </Text>
              ) : null}
            </Flex>
            <Textarea
              name="specificMoments"
              value={specificMoments}
              onChange={(event) => setSpecificMoments(event.target.value)}
              placeholder="e.g. When the speaker shares their biggest lesson"
              rows={2}
              maxLength={500}
              fontSize="13px"
            />
            <MomentSuggestions value={specificMoments} onChange={setSpecificMoments} />
          </Field.Root>
          <AdvancedSettings
            platformTargets={platformTargets}
            onPlatformTargetsChange={setPlatformTargets}
            clipCountTarget={clipCountTarget}
            onClipCountTargetChange={setClipCountTarget}
            toneConstraints={toneConstraints}
            onToneConstraintsChange={setToneConstraints}
          />
        </>
      )}
    </Stack>
  );
}
