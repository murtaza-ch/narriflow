import { Box, Flex, Stack, Text, type StackProps } from "@chakra-ui/react";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/*
 * The settings pages' shared vocabulary. Server-safe: Chakra's `chakra.*`
 * factory is undefined in server components, so only components and `as` are used.
 */

/** An icon on a soft rounded tile, the lead of a card or row. */
export function IconTile({ children, size = "9", tone = "neutral" }: { children: ReactNode; size?: string; tone?: "neutral" | "accent" }) {
  return (
    <Flex
      boxSize={size}
      flexShrink={0}
      align="center"
      justify="center"
      borderRadius="10px"
      bg={tone === "accent" ? "accent.subtle" : "bg.soft"}
      color={tone === "accent" ? "accent.fg" : "fg.muted"}
      aria-hidden
    >
      {children}
    </Flex>
  );
}

/** A titled group of settings on a subtle card: icon, title, one line, and the group's action on the right. */
export function SettingsCard({
  icon,
  title,
  description,
  action,
  children,
  ...rest
}: { icon?: ReactNode; title?: ReactNode; description?: ReactNode; action?: ReactNode; children?: ReactNode } & Omit<StackProps, "title">) {
  return (
    <Stack as="section" gap="5" bg="bg.subtle" borderRadius="l3" p={{ base: "5", md: "6" }} minW="0" {...rest}>
      {title ? (
        <Flex align={{ base: "flex-start", sm: "center" }} justify="space-between" gap="4" direction={{ base: "column", sm: "row" }}>
          <Flex align="center" gap="3" minW="0">
            {icon ? <IconTile>{icon}</IconTile> : null}
            <Stack gap="0.5" minW="0">
              <Text as="h2" fontSize="15px" fontWeight="500" color="fg">
                {title}
              </Text>
              {description ? (
                <Text fontSize="13px" color="fg.muted">
                  {description}
                </Text>
              ) : null}
            </Stack>
          </Flex>
          {action ? <Flex gap="2" flexShrink={0} align="center">{action}</Flex> : null}
        </Flex>
      ) : null}
      {children}
    </Stack>
  );
}

/** One setting or fact in a card: icon, title and a line on the left, its control or value on the right. */
export function SettingRow({ icon, title, description, control }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; control?: ReactNode }) {
  return (
    <Flex align="center" gap="4" py="3" minW="0">
      {icon ? <IconTile size="8">{icon}</IconTile> : null}
      <Stack gap="0.5" flex="1" minW="0">
        <Text fontSize="14px" fontWeight="500" color="fg">
          {title}
        </Text>
        {description ? (
          <Text fontSize="12.5px" color="fg.muted">
            {description}
          </Text>
        ) : null}
      </Stack>
      {control ? <Flex flexShrink={0} align="center" gap="2">{control}</Flex> : null}
    </Flex>
  );
}

/** A soft status pill: a colored dot and a word. */
export function StatusPill({ tone = "neutral", children }: { tone?: "accent" | "neutral" | "warning" | "danger"; children: ReactNode }) {
  const dot = { accent: "accent.solid", neutral: "fg.subtle", warning: "warning.solid", danger: "danger.solid" }[tone];
  return (
    <Flex align="center" gap="1.5" h="6" px="2.5" borderRadius="full" bg="bg.soft" fontSize="12px" fontWeight="500" color="fg" flexShrink={0}>
      <Box boxSize="1.5" borderRadius="full" bg={dot} />
      {children}
    </Flex>
  );
}

/** A number that matters, on a card: label, big value, optional meter and hint. */
export function StatTile({ icon, label, value, suffix, meter, hint }: { icon?: ReactNode; label: string; value: ReactNode; suffix?: ReactNode; meter?: number; hint?: ReactNode }) {
  return (
    <Stack gap="3" p="5" bg="bg.subtle" borderRadius="l3" minW="0">
      <Flex align="center" justify="space-between" gap="2">
        <Text fontSize="13px" color="fg.muted">
          {label}
        </Text>
        {icon ? <IconTile size="7">{icon}</IconTile> : null}
      </Flex>
      <Flex align="baseline" gap="1.5" wrap="wrap">
        <Text fontSize="28px" fontWeight="550" lineHeight="1" letterSpacing="-0.02em" fontVariantNumeric="tabular-nums">
          {value}
        </Text>
        {suffix ? (
          <Text as="span" fontSize="13px" color="fg.muted" fontVariantNumeric="tabular-nums">
            {suffix}
          </Text>
        ) : null}
      </Flex>
      {meter !== undefined ? (
        <Box h="6px" borderRadius="full" bg="bg.soft" overflow="hidden">
          <Box h="full" borderRadius="full" bg={meter >= 90 ? "warning.solid" : "accent.solid"} animation="meter-fill" style={{ width: `${Math.max(2, Math.min(100, meter))}%` }} />
        </Box>
      ) : null}
      {hint ? (
        <Text fontSize="12px" color="fg.subtle">
          {hint}
        </Text>
      ) : null}
    </Stack>
  );
}

/** Long explanations folded behind one line, so the page stays scannable. Works without JavaScript. */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box as="details" css={{ "&[open] > summary svg": { transform: "rotate(180deg)" } }}>
      <Box
        as="summary"
        display="inline-flex"
        alignItems="center"
        gap="1.5"
        cursor="pointer"
        fontSize="13px"
        fontWeight="500"
        color="fg.muted"
        listStyleType="none"
        _hover={{ color: "fg" }}
        css={{ "&::-webkit-details-marker": { display: "none" } }}
      >
        {title}
        <ChevronDown size={14} style={{ transition: "transform 150ms ease" }} />
      </Box>
      <Stack gap="2" mt="3" fontSize="13px" color="fg.muted" maxW="72ch" lineHeight="1.6">
        {children}
      </Stack>
    </Box>
  );
}
