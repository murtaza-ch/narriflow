"use client";

import { useState, type ReactNode } from "react";
import { Box, Drawer, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { SlidersHorizontal, X } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Select } from "@narriflow/ui/components/select";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { NumberInput } from "@narriflow/ui/components/number-input";
import type { CaptionPresetId, ClipPlatformTarget } from "@narriflow/validators";
import { BRAND_DEFAULT_CAPTION_PRESET_ID } from "@narriflow/validators";
import { LANGUAGE_OPTIONS } from "../../_shared/languages";
import { CaptionPresetSelect } from "../../_shared/caption-preset-select";
import { ProcessingTimeframeFields } from "./processing-timeframe-fields";

const platformOptions = [
  { value: "tiktok", label: "TikTok", short: "TikTok" },
  { value: "youtube_shorts", label: "YouTube Shorts", short: "Shorts" },
  { value: "instagram_reels", label: "Instagram Reels", short: "Reels" },
] as const;

const clipLengthItems = [
  { value: "auto", label: "Auto (use numeric)" },
  { value: "under_30s", label: "Under 30s" },
  { value: "30_to_60s", label: "30s – 60s" },
  { value: "60_to_120s", label: "1 – 2 min" },
  { value: "120_to_180s", label: "2 – 3 min" },
];

const clipLengthChipLabels: Record<string, string> = {
  auto: "Auto length",
  under_30s: "<30s",
  "30_to_60s": "30–60s",
  "60_to_120s": "1–2 min",
  "120_to_180s": "2–3 min",
};

const modeItems = [
  { value: "clip", label: "AI clipping" },
  { value: "caption_only", label: "Caption only (full length)" },
];

const languageItems = LANGUAGE_OPTIONS.map((option) => ({
  label: option.label,
  value: option.code,
}));

function SummaryChip({ children }: { children: ReactNode }) {
  return (
    <Box
      px="2"
      py="0.5"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l1"
      textStyle="data"
      fontSize="11px"
      color="fg.muted"
      whiteSpace="nowrap"
    >
      {children}
    </Box>
  );
}

function DurationField({
  name,
  label,
  defaultValue,
  min,
  max,
}: {
  name: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
}) {
  return (
    <Box>
      <Text textStyle="eyebrow" color="fg.subtle" mb="1">
        {label}
      </Text>
      <NumberInput
        size="sm"
        defaultValue={String(defaultValue)}
        min={min}
        max={max}
        step={1}
        inputProps={{ name }}
      />
    </Box>
  );
}

interface AdvancedClipSettingsProps {
  sourceLanguageEditable: boolean;
  defaultSourceLanguageCode: string | null;
  sourceDurationSec?: number | null;
  defaultProcessingStartSec?: number | null;
  defaultProcessingEndSec?: number | null;
  defaultCaptionPreset?: CaptionPresetId;
  defaultAutoRenderClips?: boolean;
  /** Inline toolbar rendering — trigger + chips on one row, no group label. */
  compact?: boolean;
}

/**
 * Detection settings — rendered once per pipeline action form. All fields
 * live inside a Chakra Drawer that is NOT portaled, so they stay inside the
 * surrounding <form> element and submit with the server action. The drawer
 * content stays mounted while closed (Chakra default), so values persist.
 */
export function AdvancedClipSettings({
  sourceLanguageEditable,
  defaultSourceLanguageCode,
  sourceDurationSec = null,
  defaultProcessingStartSec = null,
  defaultProcessingEndSec = null,
  defaultCaptionPreset = BRAND_DEFAULT_CAPTION_PRESET_ID,
  defaultAutoRenderClips = false,
  compact = false,
}: AdvancedClipSettingsProps) {
  const [open, setOpen] = useState(false);
  const [captionPreset, setCaptionPreset] = useState(defaultCaptionPreset);
  const [mode, setMode] = useState("clip");
  const [clipLengthPreset, setClipLengthPreset] = useState("auto");
  const [clipCount, setClipCount] = useState("10");
  const [platforms, setPlatforms] = useState<ClipPlatformTarget[]>([
    "tiktok",
    "youtube_shorts",
    "instagram_reels",
  ]);
  const [autoRender, setAutoRender] = useState(defaultAutoRenderClips);

  const platformSummary =
    platforms.length === platformOptions.length
      ? "All platforms"
      : platforms.length === 0
        ? "No platforms"
        : platformOptions
            .filter((option) => platforms.includes(option.value))
            .map((option) => option.short)
            .join("+");

  function togglePlatform(value: ClipPlatformTarget, checked: boolean) {
    setPlatforms((current) =>
      checked
        ? current.includes(value)
          ? current
          : [...current, value]
        : current.filter((item) => item !== value),
    );
  }

  return (
    <Box>
      <Flex align="center" gap="1.5" wrap="wrap">
        <Button
          type="button"
          variant="outline"
          size={compact ? "sm" : "xs"}
          onClick={() => setOpen(true)}
        >
          <SlidersHorizontal size={13} aria-hidden />
          <Text ms="1.5">Detection settings</Text>
        </Button>
        <SummaryChip>{mode === "clip" ? "Best clips" : "Caption only"}</SummaryChip>
        <SummaryChip>{clipLengthChipLabels[clipLengthPreset] ?? "Auto length"}</SummaryChip>
        <SummaryChip>{clipCount || "10"} clips</SummaryChip>
        <SummaryChip>{platformSummary}</SummaryChip>
        {autoRender && <SummaryChip>Auto-render</SummaryChip>}
      </Flex>

      <input type="hidden" name="clipGenerationMode" value="best" />

      {/* No Portal on purpose: fields must stay inside the parent <form>. */}
      <Drawer.Root
        open={open}
        onOpenChange={(details) => setOpen(details.open)}
        size="md"
      >
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content
            borderInlineStartWidth="1px"
          >
            <Drawer.Header
              px="5"
              pt="5"
              pb="4"
              borderBottomWidth="1px"
              borderColor="border"
            >
              <Flex align="center" justify="space-between" w="full" gap="3">
                <Box>
                  <Text textStyle="eyebrow" color="fg.subtle">
                    Detection
                  </Text>
                  <Drawer.Title textStyle="title" fontSize="md" color="fg">
                    Detection settings
                  </Drawer.Title>
                </Box>
                <IconButton
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label="Close detection settings"
                  onClick={() => setOpen(false)}
                >
                  <X size={14} />
                </IconButton>
              </Flex>
            </Drawer.Header>

            <Drawer.Body px="5" py="5">
              <Stack gap="5">
                <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="3">
                  <Box>
                    <Text textStyle="eyebrow" color="fg.subtle" mb="1">
                      Mode
                    </Text>
                    <Select
                      items={modeItems}
                      value={mode}
                      onValueChange={setMode}
                      size="sm"
                      name="mode"
                    />
                  </Box>
                  {sourceLanguageEditable && (
                    <Box>
                      <Text textStyle="eyebrow" color="fg.subtle" mb="1">
                        Language
                      </Text>
                      <Select
                        items={languageItems}
                        defaultValue={defaultSourceLanguageCode ?? "auto"}
                        size="sm"
                        name="languageCode"
                      />
                    </Box>
                  )}
                  <Box>
                    <Text textStyle="eyebrow" color="fg.subtle" mb="1">
                      Clip length
                    </Text>
                    <Select
                      items={clipLengthItems}
                      value={clipLengthPreset}
                      onValueChange={setClipLengthPreset}
                      size="sm"
                      name="clipLengthPreset"
                    />
                  </Box>
                  <Box>
                    <Text textStyle="eyebrow" color="fg.subtle" mb="1">
                      Clips
                    </Text>
                    <NumberInput
                      size="sm"
                      value={clipCount}
                      onValueChange={(value) => setClipCount(value)}
                      min={3}
                      max={30}
                      step={1}
                      inputProps={{ name: "clipCountTarget" }}
                    />
                  </Box>
                </Grid>

                <Box>
                  <Text textStyle="eyebrow" color="fg.subtle" mb="2">
                    Duration bounds (seconds)
                  </Text>
                  <Grid templateColumns={{ base: "1fr 1fr", sm: "repeat(3, 1fr)" }} gap="3">
                    <DurationField name="clipDurationSecTarget" label="Target" defaultValue={45} min={15} max={180} />
                    <DurationField name="minDurationSec" label="Min" defaultValue={15} min={5} max={120} />
                    <DurationField name="maxDurationSec" label="Max" defaultValue={90} min={10} max={180} />
                    <DurationField name="preferredMinDurationSec" label="Pref min" defaultValue={30} min={5} max={120} />
                    <DurationField name="preferredMaxDurationSec" label="Pref max" defaultValue={60} min={5} max={180} />
                  </Grid>
                </Box>

                <Stack gap="2.5">
                  <Text textStyle="eyebrow" color="fg.subtle">
                    Platforms
                  </Text>
                  <Flex gap="4" wrap="wrap">
                    {platformOptions.map((option) => (
                      <Checkbox
                        key={option.value}
                        checked={platforms.includes(option.value)}
                        onCheckedChange={(checked) =>
                          togglePlatform(option.value, checked)
                        }
                        inputProps={{
                          name: "platformTargets",
                          value: option.value,
                        }}
                      >
                        {option.label}
                      </Checkbox>
                    ))}
                  </Flex>
                  <Checkbox
                    checked={autoRender}
                    onCheckedChange={setAutoRender}
                    inputProps={{ name: "autoRenderClips" }}
                  >
                    Auto-render detected clips
                  </Checkbox>
                  <Checkbox defaultChecked inputProps={{ name: "autoHook" }}>
                    Auto-hook (favor strong opening clips)
                  </Checkbox>
                </Stack>

                <Box>
                  <Text textStyle="eyebrow" color="fg.subtle" mb="1">
                    Specific moments (optional)
                  </Text>
                  <Input
                    name="specificMoments"
                    size="sm"
                    placeholder="Find moments where they discuss pricing"
                    maxLength={500}
                  />
                </Box>

                <Box>
                  <Text textStyle="eyebrow" color="fg.subtle" mb="1">
                    Tone/category preferences
                  </Text>
                  <Input
                    name="toneConstraints"
                    size="sm"
                    defaultValue="concise, conversational"
                  />
                </Box>

                <CaptionPresetSelect
                  value={captionPreset}
                  onChange={setCaptionPreset}
                />

                <ProcessingTimeframeFields
                  sourceDurationSec={sourceDurationSec}
                  defaultStartSec={defaultProcessingStartSec}
                  defaultEndSec={defaultProcessingEndSec}
                />
              </Stack>
            </Drawer.Body>

            <Drawer.Footer
              px="5"
              py="4"
              borderTopWidth="1px"
              borderColor="border"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOpen(false)}
              >
                Done
              </Button>
            </Drawer.Footer>
          </Drawer.Content>
        </Drawer.Positioner>
      </Drawer.Root>
    </Box>
  );
}
