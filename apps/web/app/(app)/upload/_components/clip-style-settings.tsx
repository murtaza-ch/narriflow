"use client";

import { Box, chakra, Field, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Info } from "lucide-react";
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
import { CaptionPresetGallery } from "./caption-preset-gallery";

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
  autoRenderClips: boolean;
  setAutoRenderClips: (value: boolean) => void;
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
  autoRenderClips,
  setAutoRenderClips,
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
      rounded="2xl"
      p={{ base: "4", md: "5" }}
    >
      <FormatSettings
        aspectRatio={defaultAspectRatio}
        onAspectRatioChange={setDefaultAspectRatio}
        clipLength={clipLengthPreset}
        onClipLengthChange={setClipLengthPreset}
        showClipLength={mode === "clip"}
      />
      <Box borderTopWidth="1px" borderColor="border.subtle" pt="4">
        <CaptionPresetGallery
          value={captionPreset}
          onChange={setCaptionPreset}
        />
      </Box>
      {mode === "clip" ? (
        <Grid
          templateColumns={{ base: "1fr", md: "1fr 1fr" }}
          gap="4"
          bg="bg.subtle"
          rounded="xl"
          p="4"
        >
          <Flex align="center" justify="space-between" gap="3">
            <Box>
              <Text id="auto-hook-label" fontSize="13px" fontWeight="550">
                Start with a hook
              </Text>
              <Text fontSize="11px" color="fg.muted" mt="1">
                Prioritize attention-grabbing openings.
              </Text>
            </Box>
            <Switch
              checked={autoHook}
              onCheckedChange={setAutoHook}
              inputProps={{
                name: "autoHook",
                "aria-labelledby": "auto-hook-label",
              }}
            />
          </Flex>
          <Flex align="center" justify="space-between" gap="3">
            <Box>
              <Text id="auto-render-label" fontSize="13px" fontWeight="550">
                Auto-render clips
              </Text>
              <Text fontSize="11px" color="fg.muted" mt="1">
                Render automatically after detection.
              </Text>
            </Box>
            <Switch
              checked={autoRenderClips}
              onCheckedChange={setAutoRenderClips}
              inputProps={{
                name: "autoRenderClips",
                "aria-labelledby": "auto-render-label",
              }}
            />
          </Flex>
        </Grid>
      ) : (
        <Flex
          gap="2"
          align="center"
          bg="bg.subtle"
          rounded="xl"
          p="4"
          color="fg.muted"
        >
          <Info size={16} />
          <Text fontSize="12px">
            Your full video will be transcribed and rendered with captions.
          </Text>
        </Flex>
      )}
      {mode === "clip" && (
        <>
          <Field.Root>
            <Flex justify="space-between" align="center" w="full">
              <Field.Label fontSize="13px" fontWeight="550">
                Find a specific moment{" "}
                <chakra.span fontWeight="400" color="fg.subtle" ml="1">
                  Optional
                </chakra.span>
              </Field.Label>
              <Text fontSize="11px" color="fg.subtle">
                {specificMoments.length}/500
              </Text>
            </Flex>
            <Textarea
              name="specificMoments"
              value={specificMoments}
              onChange={(event) => setSpecificMoments(event.target.value)}
              placeholder="e.g. When the speaker shares their biggest lesson"
              rows={2}
              maxLength={500}
              fontSize="13px"
              bg="bg.subtle"
              rounded="lg"
            />
          </Field.Root>
          <Box borderTopWidth="1px" borderColor="border.subtle" pt="3">
            <AdvancedSettings
              platformTargets={platformTargets}
              onPlatformTargetsChange={setPlatformTargets}
              clipCountTarget={clipCountTarget}
              onClipCountTargetChange={setClipCountTarget}
              toneConstraints={toneConstraints}
              onToneConstraintsChange={setToneConstraints}
            />
          </Box>
        </>
      )}
    </Stack>
  );
}
