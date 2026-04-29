"use client";

import { useState } from "react";
import {
  Box,
  createListCollection,
  Flex,
  Grid,
  Portal,
  Select,
  Stack,
  Switch,
  Text,
} from "@chakra-ui/react";
import { ChevronDown, Sparkles } from "lucide-react";
import { Textarea } from "@narriflow/ui/components/textarea";
import type { ClipLengthPreset } from "@narriflow/validators";

const clipLengthOptions: { value: ClipLengthPreset; label: string }[] = [
  { value: "auto", label: "Auto (0–3 min)" },
  { value: "under_30s", label: "Under 30s" },
  { value: "30_to_60s", label: "30s – 60s" },
  { value: "60_to_120s", label: "1 – 2 min" },
  { value: "120_to_180s", label: "2 – 3 min" },
];

const clipLengthCollection = createListCollection({
  items: clipLengthOptions,
});

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
}

export function ClipSettingsForm({
  clipLength,
  onClipLengthChange,
  autoHook,
  onAutoHookChange,
  specificMoments,
  onSpecificMomentsChange,
}: ClipSettingsFormProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <Stack gap="18px">
      <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap="14px">
        <Box>
          <Text fontSize="13px" fontWeight="500" color="fg" mb="6px">
            Clip length
          </Text>
          <Select.Root
            collection={clipLengthCollection}
            value={[clipLength]}
            onValueChange={(details) => {
              const next = details.value[0];
              if (next) onClipLengthChange(next as ClipLengthPreset);
            }}
            size="sm"
            name="clipLengthPreset"
          >
            <Select.HiddenSelect />
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText placeholder="Select clip length" />
              </Select.Trigger>
              <Select.IndicatorGroup>
                <Select.Indicator />
              </Select.IndicatorGroup>
            </Select.Control>
            <Portal>
              <Select.Positioner>
                <Select.Content>
                  {clipLengthCollection.items.map((item) => (
                    <Select.Item item={item} key={item.value}>
                      {item.label}
                      <Select.ItemIndicator />
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Portal>
          </Select.Root>
        </Box>

        <Box>
          <Flex justify="space-between" align="center" mb="6px">
            <Text fontSize="13px" fontWeight="500" color="fg">
              Auto-hook
            </Text>
            <Switch.Root
              name="autoHook"
              checked={autoHook}
              onCheckedChange={(details) => onAutoHookChange(details.checked)}
              size="md"
            >
              <Switch.HiddenInput />
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Root>
          </Flex>
          <Text fontSize="11px" color="fg.muted">
            Prefer clips that open with a strong hook.
          </Text>
        </Box>
      </Grid>

      <Box>
        <Flex justify="space-between" align="center" mb="6px">
          <Flex align="center" gap="6px">
            <Sparkles size={13} color="var(--chakra-colors-accent-solid)" />
            <Text fontSize="13px" fontWeight="500" color="fg">
              Include specific moments
            </Text>
          </Flex>
          <Text fontSize="11px" color="fg.subtle">
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
          bg="bg.subtle"
          borderRadius="8px"
          borderColor="border"
          _focus={{ borderColor: "accent.solid", boxShadow: "none" }}
        />
        <Text fontSize="11px" color="fg.subtle" mt="4px">
          {specificMoments.length}/500
        </Text>
      </Box>

      <Box>
        <Flex
          as="button"
          onClick={() => setAdvancedOpen((value) => !value)}
          align="center"
          gap="6px"
          fontSize="12px"
          fontWeight="500"
          color="fg.muted"
          cursor="pointer"
          _hover={{ color: "fg" }}
        >
          <Box
            transform={advancedOpen ? "rotate(0deg)" : "rotate(-90deg)"}
            transition="transform 150ms ease"
          >
            <ChevronDown size={13} />
          </Box>
          Advanced controls
        </Flex>

        {advancedOpen && (
          <Stack
            gap="14px"
            mt="12px"
            p="14px"
            borderRadius="10px"
            borderWidth="1px"
            borderColor="border"
            bg="bg.subtle"
          >
            <Box>
              <Text fontSize="11px" color="fg.muted" mb="6px">
                Platform targets
              </Text>
              <Flex gap="6px" flexWrap="wrap">
                {platformOptions.map((option) => (
                  <Box
                    key={option.value}
                    as="label"
                    px="10px"
                    py="6px"
                    borderRadius="999px"
                    borderWidth="1px"
                    borderColor="border"
                    bg="bg"
                    cursor="pointer"
                  >
                    <Flex align="center" gap="6px">
                      <input
                        type="checkbox"
                        name="platformTargets"
                        value={option.value}
                        defaultChecked
                      />
                      <Text fontSize="12px" color="fg">
                        {option.label}
                      </Text>
                    </Flex>
                  </Box>
                ))}
              </Flex>
            </Box>

            <Grid templateColumns="1fr 1fr" gap="10px">
              <Box>
                <Text fontSize="11px" color="fg.muted" mb="4px">
                  Clip count
                </Text>
                <input
                  type="number"
                  name="clipCountTarget"
                  defaultValue={10}
                  min={3}
                  max={30}
                  step="1"
                  style={{
                    width: "100%",
                    padding: "7px 9px",
                    fontSize: "13px",
                    borderRadius: "6px",
                    border: "1px solid var(--chakra-colors-border)",
                    background: "var(--chakra-colors-bg)",
                    color: "inherit",
                  }}
                />
              </Box>
              <Box>
                <Text fontSize="11px" color="fg.muted" mb="4px">
                  Auto-render after detection
                </Text>
                <Box as="label" cursor="pointer" display="inline-flex" alignItems="center" gap="6px">
                  <input type="checkbox" name="autoRenderClips" />
                  <Text fontSize="12px" color="fg.muted">
                    Render TikTok / Reels variants automatically
                  </Text>
                </Box>
              </Box>
            </Grid>

            <Box>
              <Text fontSize="11px" color="fg.muted" mb="4px">
                Tone preferences
              </Text>
              <input
                name="toneConstraints"
                defaultValue="concise, conversational"
                style={{
                  width: "100%",
                  padding: "7px 9px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid var(--chakra-colors-border)",
                  background: "var(--chakra-colors-bg)",
                  color: "inherit",
                }}
              />
            </Box>
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
