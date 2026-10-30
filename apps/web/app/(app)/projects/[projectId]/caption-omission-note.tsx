"use client";

import { Box, Flex, Popover, Portal, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import type { ClipRenderCaptionDiagnostics } from "@narriflow/validators";
import { Info } from "lucide-react";
import Link from "next/link";
import { captionOmissionNote, type CaptionOmissionNote, renderedOmissionSummary } from "@/lib/caption-omissions";

/** What the popover says: the characters, why, and the one way forward. */
export function CaptionOmissionDetails({ note, studioHref }: { note: CaptionOmissionNote; studioHref: string }) {
	return (
		<Stack gap="2.5">
			<Text fontSize="13px" color="fg">
				These characters aren't in the caption fonts, so they were left out of the video.
			</Text>
			<Flex as="ul" wrap="wrap" gap="1.5" listStyleType="none" m="0" p="0" aria-label="Characters left out">
				{note.omissions.map((omission) => (
					<Box
						as="li"
						key={omission.label}
						px="1.5"
						py="0.5"
						borderRadius="l1"
						bg="bg.soft"
						textStyle="data"
						fontSize="11px"
						color="fg.muted"
					>
						{omission.label}
					</Box>
				))}
			</Flex>
			<Button asChild size="sm" variant="subtle" alignSelf="flex-start">
				<Link href={studioHref}>Edit captions</Link>
			</Button>
		</Stack>
	);
}

/**
 * A quiet line under the format picker, only when the selected render left
 * characters out of its captions. Neutral, not an error: the clip is fine.
 */
export function CaptionOmissionNoteButton({
	diagnostics,
	studioHref,
}: {
	diagnostics: ClipRenderCaptionDiagnostics | null | undefined;
	studioHref: string;
}) {
	const note = captionOmissionNote(diagnostics);
	if (!note) return null;
	return (
		<Popover.Root positioning={{ placement: "bottom" }}>
			<Popover.Trigger asChild>
				<Flex
					as="button"
					data-caption-omissions
					align="center"
					gap="1"
					mx="auto"
					mt="2"
					px="1.5"
					h="6"
					borderRadius="l1"
					color="fg.muted"
					textStyle="data"
					fontSize="11px"
					cursor="pointer"
					_hover={{ bg: "bg.softHover", color: "fg" }}
				>
					<Info size={12} aria-hidden="true" />
					{renderedOmissionSummary(note.count)}
				</Flex>
			</Popover.Trigger>
			<Portal>
				<Popover.Positioner>
					<Popover.Content w="280px" maxW="calc(100vw - 24px)" p="3">
						<CaptionOmissionDetails note={note} studioHref={studioHref} />
					</Popover.Content>
				</Popover.Positioner>
			</Portal>
		</Popover.Root>
	);
}
