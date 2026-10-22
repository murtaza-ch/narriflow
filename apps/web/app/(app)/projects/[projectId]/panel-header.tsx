import type { ReactNode } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";

/** The shared head of a project tab: what this surface is, and its actions. */
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
			align={{ base: "stretch", md: "flex-end" }}
			justify="space-between"
			gap="4"
			direction={{ base: "column", md: "row" }}
			pb="5"
			borderBottomWidth="1px"
			borderColor="border.subtle"
		>
			<Flex align="center" gap="4" minW="0">
				<Flex
					boxSize="11"
					flexShrink={0}
					align="center"
					justify="center"
					borderRadius="l2"
					bg="accent.subtle"
					color="accent.fg"
					aria-hidden="true"
				>
					{icon}
				</Flex>
				<Box minW="0">
					<Flex align="center" gap="2.5" wrap="wrap">
						<Text as="h2" textStyle="title" fontSize="22px" color="fg">
							{title}
						</Text>
						{badge}
					</Flex>
					{description ? (
						<Text fontSize="sm" color="fg.muted" mt="1" maxW="640px">
							{description}
						</Text>
					) : null}
				</Box>
			</Flex>
			{actions ? (
				<Flex gap="2" align="center" flexShrink={0} wrap="wrap">
					{actions}
				</Flex>
			) : null}
		</Flex>
	);
}
