import { Skeleton, type SkeletonProps, Stack, type StackProps } from "@chakra-ui/react";

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
