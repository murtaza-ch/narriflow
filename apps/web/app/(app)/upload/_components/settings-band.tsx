import { Box, Text, type BoxProps } from "@chakra-ui/react";
import type { ReactNode } from "react";

/** Section band: eyebrow above a 1.5px ink top-rule, content below. Shared
 *  by the file/RSS settings grid and the link Configure step. */
export function SettingsBand({
  eyebrow,
  children,
  ...rest
}: {
  eyebrow?: string;
  children: ReactNode;
} & BoxProps) {
  return (
    <Box {...rest}>
      {eyebrow && (
        <Text textStyle="eyebrow" color="fg.subtle" mb="2">
          {eyebrow}
        </Text>
      )}
      <Box layerStyle="band">{children}</Box>
    </Box>
  );
}
