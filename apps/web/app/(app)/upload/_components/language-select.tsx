"use client";

import {
  Box,
  createListCollection,
  Flex,
  Portal,
  Select,
  Text,
} from "@chakra-ui/react";
import { Globe } from "lucide-react";
import { LANGUAGE_OPTIONS } from "../_lib/languages";

const languageCollection = createListCollection({
  items: LANGUAGE_OPTIONS.map((option) => ({
    label: option.label,
    value: option.code,
  })),
});

interface LanguageSelectProps {
  value: string;
  onChange: (value: string) => void;
}

export function LanguageSelect({ value, onChange }: LanguageSelectProps) {
  return (
    <Box>
      <Flex align="center" gap="6px" mb="6px">
        <Globe size={13} color="var(--chakra-colors-fg-muted)" />
        <Text fontSize="13px" fontWeight="500" color="fg">
          Speech language
        </Text>
      </Flex>
      <Select.Root
        collection={languageCollection}
        value={[value]}
        onValueChange={(details) => {
          const next = details.value[0];
          if (next) onChange(next);
        }}
        size="sm"
        name="languageCode"
      >
        <Select.HiddenSelect />
        <Select.Control>
          <Select.Trigger>
            <Select.ValueText placeholder="Select language" />
          </Select.Trigger>
          <Select.IndicatorGroup>
            <Select.Indicator />
          </Select.IndicatorGroup>
        </Select.Control>
        <Portal>
          <Select.Positioner>
            <Select.Content>
              {languageCollection.items.map((item) => (
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
