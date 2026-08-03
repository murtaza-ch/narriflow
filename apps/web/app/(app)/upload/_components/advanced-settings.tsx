"use client";

import { useState } from "react";
import { Box, chakra, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { ChevronDown } from "lucide-react";
import { Input } from "@narriflow/ui/components/input";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { NumberInput } from "@narriflow/ui/components/number-input";
import type { ClipPlatformTarget } from "@narriflow/validators";

const platformOptions = [
  { value: "tiktok", label: "TikTok" },
  { value: "youtube_shorts", label: "YouTube Shorts" },
  { value: "instagram_reels", label: "Instagram Reels" },
] as const;

interface AdvancedSettingsProps {
  platformTargets: ClipPlatformTarget[];
  onPlatformTargetsChange: (value: ClipPlatformTarget[]) => void;
  clipCountTarget: number;
  onClipCountTargetChange: (value: number) => void;
  toneConstraints: string;
  onToneConstraintsChange: (value: string) => void;
}

/**
 * Step 2's "Advanced" disclosure: platform targets, clip count, tone.
 * Deliberately a standalone component (not a fork of the file/RSS
 * ClipSettingsForm advanced section) — clip length, auto-hook, auto-render,
 * and specific moments are promoted to their own top-level Configure bands
 * for the link path, so the shared component's grouping no longer applies.
 */
export function AdvancedSettings({
  platformTargets,
  onPlatformTargetsChange,
  clipCountTarget,
  onClipCountTargetChange,
  toneConstraints,
  onToneConstraintsChange,
}: AdvancedSettingsProps) {
  const [open, setOpen] = useState(false);

  const togglePlatform = (value: ClipPlatformTarget) => {
    onPlatformTargetsChange(
      platformTargets.includes(value)
        ? platformTargets.filter((target) => target !== value)
        : [...platformTargets, value],
    );
  };

  return (
    <Box>
      <chakra.button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
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
          transform={open ? "rotate(0deg)" : "rotate(-90deg)"}
          transition="transform 200ms cubic-bezier(0.22, 1, 0.36, 1)"
        >
          <ChevronDown size={13} />
        </Box>
        Advanced
      </chakra.button>

      {open && (
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
                  inputProps={{ name: "platformTargets", value: option.value }}
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
          </Grid>
        </Stack>
      )}
    </Box>
  );
}
