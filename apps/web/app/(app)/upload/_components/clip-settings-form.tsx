"use client";

import { useState } from "react";
import { Box, chakra, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { ChevronDown, Sparkles } from "lucide-react";
import { Textarea } from "@narriflow/ui/components/textarea";
import { Input } from "@narriflow/ui/components/input";
import { Select } from "@narriflow/ui/components/select";
import { Switch } from "@narriflow/ui/components/switch";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { NumberInput } from "@narriflow/ui/components/number-input";
import type {
  ClipLengthPreset,
  ClipPlatformTarget,
} from "@narriflow/validators";

const clipLengthItems: { value: ClipLengthPreset; label: string }[] = [
  { value: "auto", label: "Auto (0–3 min)" },
  { value: "under_30s", label: "Under 30s" },
  { value: "30_to_60s", label: "30s – 60s" },
  { value: "60_to_120s", label: "1 – 2 min" },
  { value: "120_to_180s", label: "2 – 3 min" },
];

const platformOptions = [
  { value: "tiktok", label: "TikTok" },
  { value: "youtube_shorts", label: "YouTube Shorts" },
  { value: "instagram_reels", label: "Instagram Reels" },
] as const;

interface ClipSettingsFormProps {
  clipLength: ClipLengthPreset;
  onClipLengthChange: (value: ClipLengthPreset) => void;
  autoHook: boolean;
  onAutoHookChange: (value: boolean) => void;
  specificMoments: string;
  onSpecificMomentsChange: (value: string) => void;
  platformTargets: ClipPlatformTarget[];
  onPlatformTargetsChange: (value: ClipPlatformTarget[]) => void;
  clipCountTarget: number;
  onClipCountTargetChange: (value: number) => void;
  autoRenderClips: boolean;
  onAutoRenderClipsChange: (value: boolean) => void;
  toneConstraints: string;
  onToneConstraintsChange: (value: string) => void;
}

export function ClipSettingsForm({
  clipLength,
  onClipLengthChange,
  autoHook,
  onAutoHookChange,
  specificMoments,
  onSpecificMomentsChange,
  platformTargets,
  onPlatformTargetsChange,
  clipCountTarget,
  onClipCountTargetChange,
  autoRenderClips,
  onAutoRenderClipsChange,
  toneConstraints,
  onToneConstraintsChange,
}: ClipSettingsFormProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const togglePlatform = (value: ClipPlatformTarget) => {
    onPlatformTargetsChange(
      platformTargets.includes(value)
        ? platformTargets.filter((target) => target !== value)
        : [...platformTargets, value],
    );
  };

  return (
    <Stack gap="4.5">
      <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap="3.5">
        <Box>
          <Text textStyle="eyebrow" color="fg.subtle" mb="2">
            Clip length
          </Text>
          <Select
            items={clipLengthItems}
            value={clipLength}
            onValueChange={(next) => {
              if (next) onClipLengthChange(next as ClipLengthPreset);
            }}
            placeholder="Select clip length"
            size="sm"
          />
        </Box>

        <Box>
          <Flex justify="space-between" align="center" mb="2">
            <Text textStyle="eyebrow" color="fg.subtle">
              Auto-hook
            </Text>
            <Switch
              checked={autoHook}
              onCheckedChange={onAutoHookChange}
              inputProps={{ name: "autoHook" }}
            />
          </Flex>
          <Text fontSize="11px" color="fg.muted">
            Prefer clips that open with a strong hook.
          </Text>
        </Box>
      </Grid>

      <Box>
        <Flex justify="space-between" align="center" mb="2">
          <Flex align="center" gap="1.5">
            <Box color="accent.fg" display="inline-flex">
              <Sparkles size={12} strokeWidth={1.75} />
            </Box>
            <Text textStyle="eyebrow" color="fg.subtle">
              Include specific moments
            </Text>
          </Flex>
          <Text textStyle="data" fontSize="11px" color="fg.subtle">
            Optional
          </Text>
        </Flex>
        <Textarea
          name="specificMoments"
          value={specificMoments}
          onChange={(event) => onSpecificMomentsChange(event.target.value)}
          placeholder="Find all the moments where the founder talks about pricing, retention, or hiring."
          rows={3}
          maxLength={500}
          fontSize="13px"
        />
        <Text textStyle="data" fontSize="11px" color="fg.subtle" mt="1">
          {specificMoments.length}/500
        </Text>
      </Box>

      <Box>
        <chakra.button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((value) => !value)}
          display="inline-flex"
          alignItems="center"
          gap="1.5"
          textStyle="eyebrow"
          color="fg.subtle"
          cursor="pointer"
          transition="color 120ms ease"
          _hover={{ color: "fg" }}
        >
          <Box
            transform={advancedOpen ? "rotate(0deg)" : "rotate(-90deg)"}
            transition="transform 200ms cubic-bezier(0.22, 1, 0.36, 1)"
          >
            <ChevronDown size={13} />
          </Box>
          Advanced controls
        </chakra.button>

        {advancedOpen && (
          <Stack
            gap="3.5"
            mt="3"
            pl="3"
            borderLeftWidth="1px"
            borderLeftColor="border"
            animation="fade-up"
          >
            <Box>
              <Text textStyle="eyebrow" color="fg.subtle" mb="2">
                Platform targets
              </Text>
              <Flex gap="4" rowGap="2" flexWrap="wrap">
                {platformOptions.map((option) => (
                  <Checkbox
                    key={option.value}
                    checked={platformTargets.includes(option.value)}
                    onCheckedChange={() => togglePlatform(option.value)}
                    inputProps={{
                      name: "platformTargets",
                      value: option.value,
                    }}
                  >
                    {option.label}
                  </Checkbox>
                ))}
              </Flex>
            </Box>

            <Grid templateColumns="1fr 1fr" gap="3">
              <Box>
                <Text textStyle="eyebrow" color="fg.subtle" mb="1.5">
                  Clip count
                </Text>
                <NumberInput
                  value={String(clipCountTarget)}
                  min={3}
                  max={30}
                  step={1}
                  size="sm"
                  onValueChange={(_, valueAsNumber) => {
                    if (!Number.isFinite(valueAsNumber)) return;
                    onClipCountTargetChange(
                      Math.min(30, Math.max(3, Math.round(valueAsNumber))),
                    );
                  }}
                  inputProps={{ name: "clipCountTarget" }}
                />
              </Box>
              <Box>
                <Text textStyle="eyebrow" color="fg.subtle" mb="1.5">
                  Auto-render
                </Text>
                <Checkbox
                  checked={autoRenderClips}
                  onCheckedChange={onAutoRenderClipsChange}
                  inputProps={{ name: "autoRenderClips" }}
                >
                  <Text as="span" fontSize="12px" color="fg.muted">
                    Render variants after detection
                  </Text>
                </Checkbox>
              </Box>
            </Grid>

            <Box>
              <Text textStyle="eyebrow" color="fg.subtle" mb="1.5">
                Tone preferences
              </Text>
              <Input
                name="toneConstraints"
                value={toneConstraints}
                onChange={(event) => onToneConstraintsChange(event.target.value)}
                size="sm"
                fontSize="13px"
              />
            </Box>
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
