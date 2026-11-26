import { Box, type BoxProps, Skeleton, type SkeletonProps, Stack, type StackProps } from "@chakra-ui/react";

/**
 * One placeholder block. The fill is translucent, so the same bone reads on
 * the page and on a soft card in both color modes.
 */
export function Bone(props: SkeletonProps) {
  return <Skeleton variant="pulse" bg="bg.softHover" borderRadius="l1" {...props} />;
}

/** The root of a loading screen: marks the region busy and names it. */
export function LoadingScreen({ label, children, ...props }: StackProps & { label: string }) {
  return (
    <Stack gap="8" w="full" aria-busy="true" aria-label={label} {...props}>
      {children}
    </Stack>
  );
}

/**
 * A bone inside the exact line box of the text it stands for: a non-breaking
 * space at the line's own font size and line height sets the height, so the
 * real text replaces it without moving anything. Pass the text's own props
 * (`fontSize`, `textStyle`) and the bone's width.
 */
export function LineBone({ boneWidth, ...props }: BoxProps & { boneWidth: BoxProps["w"] }) {
  return (
    <Box position="relative" aria-hidden {...props}>
      {" "}
      <Bone position="absolute" insetStart="0" top="50%" translate="0 -50%" h="0.75em" w={boneWidth} maxW="full" />
    </Box>
  );
}
