import type { ReactNode } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { BadgeInfo, CircleCheck, Info as InfoIcon, Lightbulb, type LucideIcon, OctagonAlert, TriangleAlert } from "lucide-react";
import { Icon } from "./icon";

type Tone = "accent" | "warning" | "danger";

const TONES: Record<Tone, { bg: string; icon: string }> = {
  accent: { bg: "accent.subtle", icon: "accent.fg" },
  warning: { bg: "warning.subtle", icon: "warning.fg" },
  danger: { bg: "danger.subtle", icon: "danger.fg" },
};

function Shell({ label, tone, glyph, children }: { label: string; tone: Tone; glyph: ReactNode; children?: ReactNode }) {
  return (
    <Flex role="note" aria-label={label} gap="3" my="5" px="4" py="3.5" bg={TONES[tone].bg} borderRadius="12px">
      <Flex h="1.7em" align="center" flexShrink={0} color={TONES[tone].icon} fontSize="15px" aria-hidden="true">
        {glyph}
      </Flex>
      <Box minW="0" flex="1" css={{ "& > :first-child": { mt: 0 }, "& > :last-child": { mb: 0 }, "& a": { color: "inherit", textDecoration: "underline" } }}>
        {children}
      </Box>
    </Flex>
  );
}

function typed(label: string, tone: Tone, Glyph: LucideIcon) {
  return function Callout({ children }: { children?: ReactNode }) {
    return (
      <Shell label={label} tone={tone} glyph={<Glyph size={16} />}>
        {children}
      </Shell>
    );
  };
}

export const Note = typed("Note", "accent", InfoIcon);
export const Info = typed("Info", "accent", BadgeInfo);
export const Tip = typed("Tip", "accent", Lightbulb);
export const Check = typed("Check", "accent", CircleCheck);
export const Warning = typed("Warning", "warning", TriangleAlert);
export const Danger = typed("Danger", "danger", OctagonAlert);

/** `<Callout icon color>`: a custom callout tinted by one hex colour. */
export function Callout({ icon, color, children }: { icon?: string; color?: string; children?: ReactNode }) {
  const hex = color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
  return (
    <Flex gap="3" my="5" px="4" py="3.5" bg={hex ? `${hex}1f` : "bg.subtle"} borderRadius="12px">
      {icon ? (
        <Flex h="1.7em" align="center" flexShrink={0} color={hex ?? "fg.muted"} fontSize="15px">
          <Icon icon={icon} size={16} />
        </Flex>
      ) : null}
      <Box minW="0" flex="1" css={{ "& > :first-child": { mt: 0 }, "& > :last-child": { mb: 0 } }}>
        {children}
      </Box>
    </Flex>
  );
}
