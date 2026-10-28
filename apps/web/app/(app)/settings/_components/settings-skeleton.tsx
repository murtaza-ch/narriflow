import { Box, Flex, Stack, Text, type SkeletonProps } from "@chakra-ui/react";
import { Bone } from "@narriflow/ui/components/page-loading";
import type { ReactNode } from "react";
import { IconTile } from "./settings-ui";

/*
 * What the settings loading screens share. Server-safe, like settings-ui.
 */

/** A bone on a line box of text height, so a row holds the height its real text will have. */
export function TextBone({ w, line = "21px", h = "3", ...rest }: { w: SkeletonProps["w"]; line?: string; h?: SkeletonProps["h"] } & Omit<SkeletonProps, "w" | "h">) {
  return (
    <Flex h={line} align="center">
      <Bone h={h} w={w} maxW="full" {...rest} />
    </Flex>
  );
}

/** A `StatTile` with its real label and icon; the value, meter and hint are bones. */
export function StatTileSkeleton({ icon, label, meter = false, hint = true }: { icon: ReactNode; label: string; meter?: boolean; hint?: boolean }) {
  return (
    <Stack gap="3" p="5" bg="bg.subtle" borderRadius="l3" minW="0">
      <Flex align="center" justify="space-between" gap="2">
        <Text fontSize="13px" color="fg.muted">
          {label}
        </Text>
        <IconTile size="7">{icon}</IconTile>
      </Flex>
      <TextBone w="20" line="28px" h="6" />
      {meter ? <Box h="6px" borderRadius="full" bg="bg.soft" /> : null}
      {hint ? <TextBone w="44" line="18px" h="2.5" /> : null}
    </Stack>
  );
}
