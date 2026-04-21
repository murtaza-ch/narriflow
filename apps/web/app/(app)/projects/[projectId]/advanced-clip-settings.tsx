import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { SlidersHorizontal } from "lucide-react";

const platformOptions = [
  { value: "tiktok", label: "TikTok" },
  { value: "youtube_shorts", label: "YouTube Shorts" },
  { value: "instagram_reels", label: "Instagram Reels" },
] as const;

function NumberField({
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
      <Text fontSize="11px" color="fg.muted" mb="2px">
        {label}
      </Text>
      <input
        type="number"
        name={name}
        defaultValue={defaultValue}
        min={min}
        max={max}
        step="1"
        style={{
          width: "100%",
          padding: "7px 9px",
          fontSize: "13px",
          borderRadius: "6px",
          border: "1px solid var(--chakra-colors-border)",
          background: "transparent",
          color: "inherit",
        }}
      />
    </Box>
  );
}

export function AdvancedClipSettings() {
  return (
    <Box borderRadius="8px" borderWidth="1px" borderColor="border" bg="bg.muted" p="14px">
      <Stack gap="12px">
        <Flex align="center" gap="8px">
          <SlidersHorizontal size={15} />
          <Box>
            <Text fontSize="13px" fontWeight="600" color="fg">
              Advanced AI Clips
            </Text>
            <Text fontSize="12px" color="fg.muted">
              Best-clips mode, 30-60s preferred, render on demand.
            </Text>
          </Box>
        </Flex>

        <input type="hidden" name="clipGenerationMode" value="best" />
        <Grid templateColumns={{ base: "1fr 1fr", md: "repeat(6, 1fr)" }} gap="10px">
          <NumberField name="clipCountTarget" label="Clips" defaultValue={10} min={3} max={30} />
          <NumberField name="clipDurationSecTarget" label="Target sec" defaultValue={45} min={15} max={120} />
          <NumberField name="minDurationSec" label="Min sec" defaultValue={15} min={5} max={120} />
          <NumberField name="preferredMinDurationSec" label="Pref min" defaultValue={30} min={5} max={120} />
          <NumberField name="preferredMaxDurationSec" label="Pref max" defaultValue={60} min={5} max={180} />
          <NumberField name="maxDurationSec" label="Max sec" defaultValue={90} min={10} max={180} />
        </Grid>

        <Flex gap="8px" flexWrap="wrap">
          {platformOptions.map((option) => (
            <Box
              key={option.value}
              as="label"
              px="10px"
              py="6px"
              borderRadius="999px"
              borderWidth="1px"
              borderColor="border"
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
          <Box as="label" px="10px" py="6px" borderRadius="999px" borderWidth="1px" borderColor="border">
            <Flex align="center" gap="6px">
              <input type="checkbox" name="autoRenderClips" />
              <Text fontSize="12px" color="fg">
                Auto-render detected clips
              </Text>
            </Flex>
          </Box>
        </Flex>

        <Box>
          <Text fontSize="11px" color="fg.muted" mb="2px">
            Tone/category preferences
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
              background: "transparent",
              color: "inherit",
            }}
          />
        </Box>
      </Stack>
    </Box>
  );
}
