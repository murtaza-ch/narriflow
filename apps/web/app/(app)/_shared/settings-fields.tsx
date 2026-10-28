import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";

/**
 * The settings vocabulary shared by the detection settings drawer and the
 * Recipe dialog: titled sections, selects with their label inside, slider
 * rows with a live value, and on/off settings on a soft card.
 */

/** A label rendered inside a Select trigger (`startElement`). */
export function InlineLabel({ children }: { children: string }) {
  return (
    <Text color="fg.muted" fontSize="13px" whiteSpace="nowrap">
      {children}
    </Text>
  );
}

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack as="section" gap="3.5">
      <Text as="h3" fontSize="16px" fontWeight="500" color="fg">
        {title}
      </Text>
      {children}
    </Stack>
  );
}

export function SliderField({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <Stack gap="2.5">
      <Flex align="baseline" justify="space-between" gap="3">
        <Text fontSize="13px" fontWeight="500" color="fg">
          {label}
        </Text>
        <Text textStyle="data" fontSize="12px" color="fg.muted">
          {value}
        </Text>
      </Flex>
      <Box px="1">{children}</Box>
    </Stack>
  );
}

/** An on/off setting: title and one line on a soft card, the control on the right. */
export function ToggleCard({
  labelId,
  title,
  description,
  children,
}: {
  /** Id on the title, for the switch's `aria-labelledby`. */
  labelId?: string;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <Flex align="center" justify="space-between" gap="4" bg="bg.soft" borderRadius="l2" p="4">
      <Box minW="0">
        <Text id={labelId} fontSize="14px" fontWeight="500" color="fg">
          {title}
        </Text>
        <Text fontSize="13px" color="fg.muted" mt="1">
          {description}
        </Text>
      </Box>
      <Flex align="center" gap="2" flexShrink={0}>
        {children}
      </Flex>
    </Flex>
  );
}
