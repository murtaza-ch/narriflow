import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Banner that introduces a feature (Vizard's brand kit pattern): what it
 * does, two benefits, one call to action, and an illustration of the feature
 * on the right. `UpgradeHero` is this banner with the upgrade action.
 */
export function FeatureHero({
  title,
  points,
  action,
  visual,
}: {
  title: string;
  points: string[];
  action?: ReactNode;
  visual: ReactNode;
}) {
  return (
    <Flex
      as="section"
      aria-label={title}
      position="relative"
      overflow="hidden"
      borderRadius="l3"
      bgGradient="to-r"
      gradientFrom="accent.subtle"
      gradientTo="accent.muted"
      minH={{ base: "auto", md: "220px" }}
      align="stretch"
    >
      <Stack gap="4" px={{ base: "6", md: "9" }} py={{ base: "6", md: "8" }} flex="1" minW="0" justify="center" position="relative" zIndex="1">
        <Text as="h2" textStyle="title" fontSize={{ base: "19px", md: "22px" }} lineHeight="1.25" color="fg">
          {title}
        </Text>
        <Stack as="ul" gap="1.5" listStyleType="none">
          {points.map((point) => (
            <Flex as="li" key={point} align="flex-start" gap="2" fontSize="14px" color="fg.muted">
              <Box color="accent.fg" mt="0.5" flexShrink={0}>
                <Check size={15} aria-hidden />
              </Box>
              {point}
            </Flex>
          ))}
        </Stack>
        {action ? <Box pt="2">{action}</Box> : null}
      </Stack>
      <Box display={{ base: "none", md: "block" }} position="relative" flexShrink={0} w={{ md: "320px", xl: "400px" }} aria-hidden="true">
        {visual}
      </Box>
    </Flex>
  );
}
