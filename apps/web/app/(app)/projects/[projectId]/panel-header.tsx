import type { ReactNode } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";

/**
 * The shared head of a project tab: what this surface is, and its actions.
 * The tab above already names it, so the head stays quiet: a small icon and
 * title, one line of description, no rule.
 */
export function PanelHeader({
	icon,
	title,
	badge,
	description,
	actions,
}: {
	icon: ReactNode;
	title: string;
	badge?: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<Flex
			align={{ base: "stretch", md: "center" }}
			justify="space-between"
			gap="4"
			direction={{ base: "column", md: "row" }}
		>
			<Box minW="0">
				<Flex align="center" gap="2" wrap="wrap">
					<Flex color="accent.fg" flexShrink={0} aria-hidden="true" css={{ "& svg": { width: "18px", height: "18px" } }}>
						{icon}
					</Flex>
					<Text as="h2" fontSize="17px" fontWeight="550" letterSpacing="-0.01em" color="fg">
						{title}
					</Text>
					{badge}
				</Flex>
				{description ? (
					<Text fontSize="13px" color="fg.muted" mt="1" maxW="72ch">
						{description}
					</Text>
				) : null}
			</Box>
			{actions ? (
				<Flex gap="2" align="center" flexShrink={0} wrap="wrap">
					{actions}
				</Flex>
			) : null}
		</Flex>
	);
}
