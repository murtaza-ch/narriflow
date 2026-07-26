"use client";

import {
  Box,
  createListCollection,
  Portal,
  Select,
  Text,
} from "@chakra-ui/react";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  captionPresetOptions,
  type CaptionPresetId,
} from "@narriflow/validators";

const captionPresetCollection = createListCollection({
  items: captionPresetOptions.map((option) => ({
    label: option.name,
    value: option.id,
  })),
});

interface CaptionPresetSelectProps {
  value: CaptionPresetId;
  onChange: (value: CaptionPresetId) => void;
}

export function CaptionPresetSelect({
  value,
  onChange,
}: CaptionPresetSelectProps) {
  return (
    <Box>
      <Text textStyle="eyebrow" color="fg.subtle" mb="8px">
        Caption preset
      </Text>
      <Select.Root
        collection={captionPresetCollection}
        value={[value]}
        onValueChange={(details) => {
          const next = details.value[0] as CaptionPresetId | undefined;
          onChange(next ?? BRAND_DEFAULT_CAPTION_PRESET_ID);
        }}
        size="sm"
        name="captionPreset"
      >
        <Select.HiddenSelect />
        <Select.Control>
          <Select.Trigger>
            <Select.ValueText placeholder="Select caption preset" />
          </Select.Trigger>
          <Select.IndicatorGroup>
            <Select.Indicator />
          </Select.IndicatorGroup>
        </Select.Control>
        <Portal>
          <Select.Positioner>
            <Select.Content>
              {captionPresetCollection.items.map((item) => (
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
  );
}
