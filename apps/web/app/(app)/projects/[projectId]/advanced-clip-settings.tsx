"use client";

import { useId, useState } from "react";
import { Box, chakra, CloseButton, Drawer, Field, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Check, Info, SlidersHorizontal } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Select } from "@narriflow/ui/components/select";
import { Slider } from "@narriflow/ui/components/slider";
import { Switch } from "@narriflow/ui/components/switch";
import { Textarea } from "@narriflow/ui/components/textarea";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  clipLengthPresetRanges,
  type CaptionPresetId,
  type ClipLengthPreset,
  type ClipPlatformTarget,
} from "@narriflow/validators";
import { SocialPlatformMark } from "@/lib/social-platform-mark";
import { CaptionPresetGallery } from "../../_shared/caption-preset-gallery";
import { LANGUAGE_OPTIONS } from "../../_shared/languages";
import { InlineLabel, SettingsSection as Section, SliderField, ToggleCard } from "../../_shared/settings-fields";
import { ProcessingTimeframeFields } from "./processing-timeframe-fields";
import { MomentSuggestions } from "../../_shared/moment-suggestions";
import { ToneChips } from "../../_shared/tone-chips";
import { clipLengthItems as sharedClipLengthItems } from "../../upload/_components/format-settings";

const platformOptions = [
  { value: "tiktok", label: "TikTok", short: "TikTok" },
  { value: "youtube_shorts", label: "YouTube Shorts", short: "Shorts" },
  { value: "instagram_reels", label: "Instagram Reels", short: "Reels" },
] as const;

// The upload screen's list, except that here "Auto" opens the range sliders below.
const clipLengthItems = sharedClipLengthItems.map((item) =>
  item.value === "auto" ? { ...item, description: "Set the range yourself below" } : item,
);

const clipLengthChipLabels: Record<ClipLengthPreset, string> = {
  auto: "Auto length",
  under_30s: "<30s",
  "30_to_60s": "30–60s",
  "60_to_120s": "1–2 min",
  "120_to_180s": "2–3 min",
};

const modeItems = [
  { value: "clip", label: "AI clips" },
  { value: "caption_only", label: "Caption only" },
];

const languageItems = LANGUAGE_OPTIONS.map((option) => ({
  label: option.label,
  value: option.code,
}));

// Duration sliders share one 5s–3min scale. The content-pack schema needs
// min ≤ preferred min ≤ preferred max ≤ max, min and preferred min ≤ 120s,
// and a target of at least 15s inside min–max.
const DURATION_SCALE = { min: 5, max: 180, step: 5 };
const autoRange = clipLengthPresetRanges.auto;

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

interface AdvancedClipSettingsProps {
  sourceLanguageEditable: boolean;
  defaultSourceLanguageCode: string | null;
  sourceDurationSec?: number | null;
  /** Frames from across the source, for the timeframe's film strip. */
  sourceFrames?: string[];
  defaultProcessingStartSec?: number | null;
  defaultProcessingEndSec?: number | null;
  defaultCaptionPreset?: CaptionPresetId;
  /** Sized to sit beside a `sm` action button. */
  compact?: boolean;
}

/**
 * Detection settings — rendered once per pipeline action form. The drawer is
 * NOT portaled so it stays inside the surrounding <form>. Mode and the
 * timeframe submit from inside it; every other value submits through the
 * hidden inputs beside the trigger.
 */
export function AdvancedClipSettings({
  sourceLanguageEditable,
  defaultSourceLanguageCode,
  sourceDurationSec = null,
  sourceFrames = [],
  defaultProcessingStartSec = null,
  defaultProcessingEndSec = null,
  defaultCaptionPreset = BRAND_DEFAULT_CAPTION_PRESET_ID,
  compact = false,
}: AdvancedClipSettingsProps) {
  const hookLabelId = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("clip");
  const [languageCode, setLanguageCode] = useState(defaultSourceLanguageCode ?? "auto");
  const [clipLengthPreset, setClipLengthPreset] = useState<ClipLengthPreset>("auto");
  const [clipCount, setClipCount] = useState(10);
  const [allowed, setAllowed] = useState<[number, number]>([
    autoRange.minDurationSec,
    autoRange.maxDurationSec,
  ]);
  const [preferred, setPreferred] = useState<[number, number]>([
    autoRange.preferredMinDurationSec,
    autoRange.preferredMaxDurationSec,
  ]);
  const [platforms, setPlatforms] = useState<ClipPlatformTarget[]>(
    platformOptions.map((option) => option.value),
  );
  const [autoHook, setAutoHook] = useState(true);
  const [specificMoments, setSpecificMoments] = useState("");
  const [toneConstraints, setToneConstraints] = useState("concise, conversational");
  const [captionPreset, setCaptionPreset] = useState(defaultCaptionPreset);

  const clipMode = mode === "clip";
  const customLength = clipMode && clipLengthPreset === "auto";
  const targetSec = clamp(
    Math.round((preferred[0] + preferred[1]) / 2),
    Math.max(15, allowed[0]),
    allowed[1],
  );

  const platformSummary =
    platforms.length === platformOptions.length
      ? "All platforms"
      : platformOptions
          .filter((option) => platforms.includes(option.value))
          .map((option) => option.short)
          .join("+");
  const summary = clipMode
    ? [clipLengthChipLabels[clipLengthPreset], `${clipCount} clips`, platformSummary]
    : ["Caption only"];

  function changeAllowed(value: number[]) {
    const min = Math.min(value[0] ?? allowed[0], 120);
    const max = Math.max(value[1] ?? allowed[1], 15, min);
    setAllowed([min, max]);
    setPreferred(([preferredMin, preferredMax]) => {
      const nextMin = clamp(preferredMin, min, Math.min(max, 120));
      return [nextMin, clamp(preferredMax, nextMin, max)];
    });
  }

  function changePreferred(value: number[]) {
    const nextMin = clamp(value[0] ?? preferred[0], allowed[0], Math.min(allowed[1], 120));
    setPreferred([nextMin, clamp(value[1] ?? preferred[1], nextMin, allowed[1])]);
  }

  // At least one platform stays selected; the last one can't be switched off.
  function togglePlatform(value: ClipPlatformTarget) {
    setPlatforms((current) =>
      current.includes(value)
        ? current.length > 1
          ? current.filter((item) => item !== value)
          : current
        : [...current, value],
    );
  }

  return (
    <Box minW="0" maxW="full">
      {/* One control: the current settings are its label. */}
      <Button
        type="button"
        variant="subtle"
        size={compact ? "sm" : "xs"}
        maxW="full"
        aria-label={`Detection settings: ${summary.join(", ")}`}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal size={16} aria-hidden />
        <Text as="span" ms="1.5" minW="0" truncate fontVariantNumeric="tabular-nums">
          {summary.join(" · ")}
        </Text>
      </Button>

      <input type="hidden" name="clipGenerationMode" value="best" />
      {sourceLanguageEditable && <input type="hidden" name="languageCode" value={languageCode} />}
      <input type="hidden" name="captionPreset" value={captionPreset} />
      {clipMode && (
        <>
          <input type="hidden" name="clipLengthPreset" value={clipLengthPreset} />
          <input type="hidden" name="clipCountTarget" value={clipCount} />
          {platforms.map((platform) => (
            <input key={platform} type="hidden" name="platformTargets" value={platform} />
          ))}
          <input type="hidden" name="autoHook" value={String(autoHook)} />
          <input type="hidden" name="specificMoments" value={specificMoments} />
          <input type="hidden" name="toneConstraints" value={toneConstraints} />
        </>
      )}
      {customLength && (
        <>
          <input type="hidden" name="minDurationSec" value={allowed[0]} />
          <input type="hidden" name="maxDurationSec" value={allowed[1]} />
          <input type="hidden" name="preferredMinDurationSec" value={preferred[0]} />
          <input type="hidden" name="preferredMaxDurationSec" value={preferred[1]} />
          <input type="hidden" name="clipDurationSecTarget" value={targetSec} />
        </>
      )}

      {/* No Portal on purpose: the timeframe fields must stay inside the parent <form>. */}
      <Drawer.Root open={open} onOpenChange={(details) => setOpen(details.open)} size="md">
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content
            maxW={{ base: "100vw", md: "480px" }}
            h="100dvh"
            bg="bg.sidebar"
            display="flex"
            flexDirection="column"
          >
            <Drawer.Header px={{ base: "4", md: "6" }} py="4" flexShrink={0}>
              <Stack gap="0.5">
                <Drawer.Title fontSize="18px" fontWeight="500">
                  Detection settings
                </Drawer.Title>
                <Text color="fg.muted" fontSize="13px">
                  Applies to the next run.
                </Text>
              </Stack>
            </Drawer.Header>
            <Drawer.CloseTrigger asChild>
              <CloseButton type="button" size="sm" borderRadius="full" aria-label="Close detection settings" />
            </Drawer.CloseTrigger>

            <Drawer.Body
              p="0"
              mx={{ base: "0", md: "2" }}
              bg="bg"
              borderRadius={{ base: "0", md: "12px" }}
              overflowY="auto"
            >
              <Stack gap="8" p="5">
                <Stack gap="3">
                  <SegmentedControl
                    name="mode"
                    items={modeItems}
                    value={mode}
                    onValueChange={setMode}
                    size="md"
                    w="full"
                    css={{ "& > [data-part=item]": { flex: "1", justifyContent: "center" } }}
                  />
                  {sourceLanguageEditable && (
                    <Select
                      ariaLabel="Language"
                      items={languageItems}
                      value={languageCode}
                      onValueChange={setLanguageCode}
                      startElement={<InlineLabel>Language</InlineLabel>}
                      size="md"
                    />
                  )}
                  {!clipMode && (
                    <Flex gap="2" align="center" bg="bg.soft" borderRadius="l2" p="4" color="fg.muted">
                      <Info size={16} aria-hidden />
                      <Text fontSize="13px">
                        Your full video will be transcribed and rendered with captions.
                      </Text>
                    </Flex>
                  )}
                </Stack>

                {clipMode && (
                  <Section title="Clips">
                    <Select
                      ariaLabel="Clip length"
                      items={clipLengthItems}
                      value={clipLengthPreset}
                      onValueChange={(value) => setClipLengthPreset(value as ClipLengthPreset)}
                      startElement={<InlineLabel>Clip length</InlineLabel>}
                      size="md"
                    />
                    <Stack gap="5" pt="1">
                      <SliderField label="Number of clips" value={String(clipCount)}>
                        <Slider
                          aria-label={["Number of clips"]}
                          min={3}
                          max={30}
                          step={1}
                          value={clipCount}
                          onValueChange={(value) => setClipCount(Number(value))}
                        />
                      </SliderField>
                      {customLength && (
                        <>
                          <SliderField label="Clip length range" value={`${allowed[0]}–${allowed[1]}s`}>
                            <Slider
                              aria-label={["Shortest clip", "Longest clip"]}
                              {...DURATION_SCALE}
                              value={allowed}
                              onValueChange={(value) => changeAllowed(value as number[])}
                            />
                          </SliderField>
                          <SliderField label="Sweet spot" value={`${preferred[0]}–${preferred[1]}s`}>
                            <Slider
                              aria-label={["Preferred shortest", "Preferred longest"]}
                              {...DURATION_SCALE}
                              value={preferred}
                              onValueChange={(value) => changePreferred(value as number[])}
                            />
                          </SliderField>
                        </>
                      )}
                    </Stack>
                  </Section>
                )}

                {clipMode && (
                  <Section title="Platforms">
                    <Grid templateColumns="repeat(3, minmax(0, 1fr))" gap="2">
                      {platformOptions.map((option) => {
                        const selected = platforms.includes(option.value);
                        return (
                          <chakra.button
                            key={option.value}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => togglePlatform(option.value)}
                            position="relative"
                            display="flex"
                            flexDirection="column"
                            alignItems="flex-start"
                            gap="3"
                            p="3"
                            borderRadius="l2"
                            bg={selected ? "accent.subtle" : "bg.soft"}
                            textAlign="left"
                            cursor="pointer"
                            transition="background-color 150ms ease"
                            _hover={{ bg: selected ? "accent.muted" : "bg.softHover" }}
                          >
                            <SocialPlatformMark platform={option.value} size="6" />
                            <Text fontSize="13px" fontWeight="500" color="fg" lineClamp={1}>
                              {option.label}
                            </Text>
                            {selected && (
                              <Flex
                                position="absolute"
                                top="2.5"
                                right="2.5"
                                boxSize="18px"
                                align="center"
                                justify="center"
                                bg="accent.solid"
                                color="accent.contrast"
                                borderRadius="full"
                              >
                                <Check size={11} strokeWidth={3} />
                              </Flex>
                            )}
                          </chakra.button>
                        );
                      })}
                    </Grid>
                  </Section>
                )}

                {clipMode && (
                  <Section title="Focus">
                    <ToggleCard
                      labelId={hookLabelId}
                      title="Start with a hook"
                      description="Prefer clips that open on an attention-grabbing line"
                    >
                      <Switch
                        checked={autoHook}
                        onCheckedChange={setAutoHook}
                        inputProps={{ "aria-labelledby": hookLabelId }}
                      />
                    </ToggleCard>
                    <Field.Root>
                      <Flex justify="space-between" align="center" w="full">
                        <Field.Label fontSize="13px" fontWeight="500">
                          Find a specific moment
                          <chakra.span fontWeight="400" color="fg.subtle" ml="1">
                            Optional
                          </chakra.span>
                        </Field.Label>
                        {specificMoments.length > 0 ? (
                          <Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums">
                            {specificMoments.length}/500
                          </Text>
                        ) : null}
                      </Flex>
                      <Textarea
                        value={specificMoments}
                        onChange={(event) => setSpecificMoments(event.target.value)}
                        placeholder="e.g. When they discuss pricing"
                        rows={2}
                        maxLength={500}
                        fontSize="13px"
                      />
                      <MomentSuggestions value={specificMoments} onChange={setSpecificMoments} />
                    </Field.Root>
                    <Field.Root>
                      <Field.Label fontSize="13px" fontWeight="500">
                        Tone
                      </Field.Label>
                      <ToneChips value={toneConstraints} onChange={setToneConstraints} />
                    </Field.Root>
                  </Section>
                )}

                <CaptionPresetGallery value={captionPreset} onChange={setCaptionPreset} />

                <Box bg="bg.soft" borderRadius="l2" p="4">
                  <ProcessingTimeframeFields
                    sourceDurationSec={sourceDurationSec}
                    frames={sourceFrames}
                    defaultStartSec={defaultProcessingStartSec}
                    defaultEndSec={defaultProcessingEndSec}
                  />
                </Box>
              </Stack>
            </Drawer.Body>

            <Drawer.Footer px={{ base: "4", md: "6" }} py="3" flexShrink={0}>
              <Button type="button" size="sm" onClick={() => setOpen(false)}>
                Done
              </Button>
            </Drawer.Footer>
          </Drawer.Content>
        </Drawer.Positioner>
      </Drawer.Root>
    </Box>
  );
}
