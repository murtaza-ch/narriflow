import { Box, Flex, Image, Stack, Text, type StackProps } from "@chakra-ui/react";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * User colors sit on any surface, so swatches carry a faint neutral ring that
 * reads in both modes (white on porcelain, graphite on graphite).
 */
export const SWATCH_RING = "inset 0 0 0 1px rgba(128, 128, 128, 0.22)";

export function plural(count: number, word: string) {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

export interface BrandTab {
  label: string;
  href: string;
  active: boolean;
  count?: number;
}

/** Page tabs that navigate (the active tab is a search parameter); styled like the project tabs. */
export function BrandTabs({ label, tabs }: { label: string; tabs: BrandTab[] }) {
  return (
    <Flex
      as="nav"
      aria-label={label}
      gap="6"
      borderBottomWidth="1px"
      borderColor="border.subtle"
      overflowX="auto"
      css={{ scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }}
    >
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} aria-current={tab.active ? "page" : undefined} scroll={false}>
          <Flex
            position="relative"
            align="center"
            gap="1.5"
            py="3"
            fontSize="14px"
            fontWeight="500"
            whiteSpace="nowrap"
            color={tab.active ? "fg" : "fg.muted"}
            transition="color 120ms ease"
            _hover={{ color: "fg" }}
          >
            {tab.label}
            {tab.count ? (
              <Box
                as="span"
                px="1.5"
                bg="bg.soft"
                borderRadius="full"
                fontSize="11px"
                lineHeight="1.5"
                fontVariantNumeric="tabular-nums"
                color="fg.muted"
              >
                {tab.count}
              </Box>
            ) : null}
            {tab.active ? (
              <Box position="absolute" left="0" right="0" bottom="-1px" h="2px" borderRadius="full" bg="accent.solid" animation="rule-in" />
            ) : null}
          </Flex>
        </Link>
      ))}
    </Flex>
  );
}

/** A titled group of settings on a subtle card. */
export function Panel({
  title,
  action,
  children,
  ...rest
}: { title: string; action?: ReactNode; children: ReactNode } & Omit<StackProps, "title">) {
  return (
    <Stack as="section" gap="5" bg="bg.subtle" borderWidth="1px" borderColor="border.card" borderRadius="l3" p={{ base: "5", md: "6" }} {...rest}>
      <Flex align="center" justify="space-between" gap="3" minH="9">
        <Text as="h2" fontSize="15px" fontWeight="500">
          {title}
        </Text>
        {action}
      </Flex>
      {children}
    </Stack>
  );
}

/** A tab's toolbar: what's listed on the left, the tab's one action on the right. */
export function TabToolbar({ summary, action }: { summary: ReactNode; action?: ReactNode }) {
  return (
    <Flex align="center" justify="space-between" gap="3" minH="9" wrap="wrap">
      <Text fontSize="13px" color="fg.muted">
        {summary}
      </Text>
      {action}
    </Flex>
  );
}

export interface BrandColors {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string | null;
}

/**
 * The profile's mark: its logo, or "Aa" in the primary color on the
 * secondary, with the signal color as a dot.
 */
export function BrandMark({ colors, logoUrl, name, size = 56 }: { colors: BrandColors; logoUrl?: string | null; name: string; size?: number }) {
  return (
    <Flex
      position="relative"
      flexShrink={0}
      align="center"
      justify="center"
      overflow="hidden"
      borderRadius={size >= 48 ? "14px" : "10px"}
      style={{ width: size, height: size, background: colors.secondaryColor }}
    >
      {logoUrl ? (
        <Image src={logoUrl} alt={`${name} logo`} w="78%" h="78%" objectFit="contain" />
      ) : (
        <Text fontFamily="display" fontWeight="600" letterSpacing="-0.03em" lineHeight="1" style={{ color: colors.primaryColor, fontSize: Math.round(size * 0.4) }}>
          Aa
        </Text>
      )}
      {colors.accentColor ? (
        <Box
          position="absolute"
          borderRadius="full"
          style={{ background: colors.accentColor, width: Math.max(6, size * 0.16), height: Math.max(6, size * 0.16), right: size * 0.12, bottom: size * 0.12 }}
        />
      ) : null}
    </Flex>
  );
}

/** Primary, secondary and signal as a row of dots. */
export function PaletteDots({ colors, size = 14 }: { colors: BrandColors; size?: number }) {
  const values = [colors.primaryColor, colors.secondaryColor, colors.accentColor].filter((value): value is string => Boolean(value));
  return (
    <Flex aria-label={`Colors ${values.join(", ")}`} role="img" gap="1">
      {values.map((value, index) => (
        <Box key={`${value}-${index}`} borderRadius="full" style={{ width: size, height: size, background: value }} />
      ))}
    </Flex>
  );
}

/** A label over footage: the studio scrim keeps it legible on any frame. */
export function CoverChip({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <Flex align="center" gap="1" h="6" px="2" maxW="full" borderRadius="full" bg="studio.scrim" color="studio.fg" fontSize="12px" fontWeight="500" backdropFilter="blur(6px)">
      {icon ? (
        <Box as="span" color="studio.accentFg" display="inline-flex" flexShrink={0}>
          {icon}
        </Box>
      ) : null}
      <Text as="span" truncate>
        {children}
      </Text>
    </Flex>
  );
}
