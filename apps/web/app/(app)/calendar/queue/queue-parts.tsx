import { Flex, Stack, Text, type FlexProps } from "@chakra-ui/react";
import type { ReactNode } from "react";
import type { SocialPlatform } from "@narriflow/validators";
import { SocialPlatformMark } from "@/lib/social-platform-mark";

type ChipTone = "neutral" | "accent" | "warning";

const CHIP_TONES: Record<ChipTone, { bg: string; color: string }> = {
	neutral: { bg: "bg.soft", color: "fg.muted" },
	accent: { bg: "accent.subtle", color: "accent.fg" },
	warning: { bg: "warning.subtle", color: "warning.fg" },
};

/** One fact as a soft chip: the colour says the state before the words do. */
export function Chip({ tone = "neutral", icon, children, ...rest }: { tone?: ChipTone; icon?: ReactNode; children: ReactNode } & FlexProps) {
	const { bg, color } = CHIP_TONES[tone];
	return (
		<Flex align="center" gap="1.5" minH="6" px="2.5" py="0.5" borderRadius="full" bg={bg} color={color} fontSize="12px" fontVariantNumeric="tabular-nums" {...rest}>
			{icon ? (
				<Flex flexShrink={0} aria-hidden>
					{icon}
				</Flex>
			) : null}
			{children}
		</Flex>
	);
}

/** An account's platform logo on a round panel, the same mark in the inbox and the schedule. */
export function AccountMark({ platform }: { platform: SocialPlatform }) {
	return (
		<Flex boxSize="9" flexShrink={0} align="center" justify="center" borderRadius="full" bg="bg.panel">
			<SocialPlatformMark platform={platform} />
		</Flex>
	);
}

/** A section's empty state: one quiet row on a soft card, so two of them never outweigh the page. */
export function QueueEmpty({ visual, title, description, action }: { visual: ReactNode; title: string; description: string; action?: ReactNode }) {
	return (
		<Flex direction={{ base: "column", md: "row" }} align={{ base: "flex-start", md: "center" }} gap={{ base: "4", md: "5" }} p={{ base: "5", md: "6" }} bg="bg.subtle" borderRadius="l3">
			<Flex flexShrink={0} align="center" aria-hidden>
				{visual}
			</Flex>
			<Stack gap="0.5" flex="1" minW="0">
				<Text as="h3" fontSize="14px" fontWeight="500">
					{title}
				</Text>
				<Text fontSize="13px" color="fg.muted" maxW="64ch">
					{description}
				</Text>
			</Stack>
			{action}
		</Flex>
	);
}
