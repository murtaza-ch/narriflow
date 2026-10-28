"use client";

import { Box, Flex, Stack } from "@chakra-ui/react";
import { Bone } from "@narriflow/ui/components/page-loading";
import { ChevronDown } from "lucide-react";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

/** The project tabs, in order; the page lands on Clips unless `?tab=` names another. */
const TABS = ["Clips", "Transcript", "Repurpose", "Dubbing", "Review", "Posts", "Analytics", "Activity"];

/** Action widths: Publish · Edit · Download/Render. */
const ACTION_WIDTHS = [70, 73, 93];

/**
 * Project page placeholder — a mirror of the heading, tabs, toolbar and clip
 * cards. The tab list and cards carry the real components' data attributes,
 * so the workspace stylesheet (project-workspace.module.css) spaces and sizes
 * them exactly like the real view: the three-column gallery grid, or
 * full-width desk rows. Static labels are real text; bones stand in for data.
 */
export function ProjectSkeleton() {
	const params = useSearchParams();
	const isGallery = params.get("view") !== "desk";
	// A link straight to a tab (e.g. Send for review) shows that tab loading.
	const current = TABS.find((tab) => tab.toLowerCase() === params.get("tab")) ?? "Clips";

	return (
		// Same root as the page: a 1400px column with a 24px rhythm.
		<Stack
			gap={{ base: "4", md: "6" }}
			maxW="1400px"
			mx="auto"
			w="full"
			aria-busy="true"
			aria-label="Loading project"
		>
			{/* Heading — title, source meta, Project details · Share · more */}
			<Flex
				data-project-heading
				align="flex-start"
				gap="4"
				direction={{ base: "column", md: "row" }}
			>
				<Stack gap="3" flex="1" minW="0">
					{/* Bones sit inside the real line boxes: the title is
					    clamp(24px, 2.3vw, 34px) at 1.2, the meta line 18px. */}
					<Flex h="clamp(28.8px, 2.76vw, 40.8px)" align="center">
						<Bone h="8" w="min(560px, 85%)" borderRadius="l2" />
					</Flex>
					<Flex h="18px" align="center" gap="3">
						<Bone boxSize="4" />
						<Bone h="3" w="9" />
						<Bone h="3" w="20" />
					</Flex>
				</Stack>
				<Flex gap="2" flexShrink={0}>
					<Bone h="9" w="136px" borderRadius="control" />
					<Bone h="9" w="85px" borderRadius="control" />
					<Bone boxSize="9" borderRadius="control" />
				</Flex>
			</Flex>

			<Box>
				{/* Tabs — the current one underlined; the Clips count is data */}
				<Flex
					data-scope="tabs"
					data-part="list"
					h="37px"
					overflow="hidden"
					borderBottomWidth="1px"
					borderColor="border.subtle"
				>
					{TABS.map((tab) => (
						<Flex
							key={tab}
							position="relative"
							align="center"
							flexShrink={0}
							px="3"
							fontSize="sm"
							fontWeight="500"
							whiteSpace="nowrap"
							color={tab === current ? "fg" : "fg.muted"}
						>
							{tab}
							{tab === "Clips" ? <Bone h="4" w="5" ms="1.5" borderRadius="full" /> : null}
							{tab === current ? (
								<Box position="absolute" insetInline="0" bottom="-1px" h="2px" bg="accent.solid" />
							) : null}
						</Flex>
					))}
				</Flex>

				{current === "Clips" ? (
					<Box pt="6">
						{/* Toolbar — layout toggle, sort, filters · select all */}
						<Flex align="center" justify="space-between" gap="3" pb="3" mb="1">
							<Flex align="center" gap="3">
								<Bone h="9" w="86px" borderRadius="control" />
								<Bone h="9" w="152px" borderRadius="control" />
								<Bone boxSize="9" borderRadius="l2" />
							</Flex>
							<Flex align="center" gap="2" fontSize="13px" color="fg.muted">
								<Bone boxSize="4" />
								Select all
							</Flex>
						</Flex>

						<Stack data-clip-list gap="0" pt="3">
							{Array.from({ length: 6 }).map((_, index) => (
								<SkeletonClipCard key={index} isGallery={isGallery} />
							))}
						</Stack>
					</Box>
				) : (
					<PanelSkeleton />
				)}
			</Box>
		</Stack>
	);
}

/**
 * Any other tab: its quiet header (icon, title, one line) over a few soft
 * rows — the shape every non-Clips tab opens with.
 */
function PanelSkeleton() {
	return (
		<Stack pt="6" gap="6">
			<Flex align="flex-start" justify="space-between" gap="4">
				<Stack gap="2">
					<Flex align="center" gap="2">
						<Bone boxSize="5" />
						<Bone h="5" w="40" />
					</Flex>
					<Bone h="3.5" w="64" maxW="70vw" />
				</Stack>
				<Bone h="9" w="28" borderRadius="control" flexShrink={0} />
			</Flex>
			<Stack gap="3">
				{[0, 1, 2].map((row) => (
					<Bone key={row} h="20" borderRadius="l3" />
				))}
			</Stack>
		</Stack>
	);
}

function SkeletonClipCard({ isGallery }: { isGallery: boolean }) {
	// Gallery pins selection and score to the card's top corners; desk rows
	// carry them on the preview — the same split ClipRow makes.
	const corners = (
		<>
			<Bone position="absolute" top={isGallery ? "4" : "2"} insetStart={isGallery ? "4" : "2"} boxSize="4" />
			<Stack position="absolute" top={isGallery ? "4" : "2"} insetEnd={isGallery ? "4" : "2"} gap="1" align="flex-end">
				<Bone h="5" w="6" />
				<Bone h="2.5" w="9" />
			</Stack>
		</>
	);

	return (
		<Box data-clip-card position="relative" borderRadius="l3" mb="4" p="5" bg="bg.panel">
			{isGallery && corners}
			<Flex
				data-clip-body
				gap={{ base: "4", md: "6" }}
				align="stretch"
				direction={{ base: "column", md: "row" }}
			>
				<Box data-clip-media flexShrink={0} w="200px" alignSelf={{ base: "center", md: "flex-start" }}>
					<Box position="relative" w="full" aspectRatio={9 / 16}>
						<Bone position="absolute" inset="0" borderRadius="l2" />
						{!isGallery && corners}
					</Box>
					{/* The format picker's recessed track */}
					<Bone h="30px" w="196px" maxW="full" mx="auto" mt="2.5" borderRadius="l2" />
				</Box>

				<Stack data-clip-copy flex="1" minW="0" w="full" gap="4">
					<Flex align="flex-start" gap="2">
						{/* Eyebrow, title (two lines in the narrow gallery column), time range */}
						<Box minW="0" flex="1">
							<TextLine h="20px" w="28" size="2.5" mb="1" />
							<TextLine h="24px" w="85%" size="4" />
							{isGallery ? <TextLine h="24px" w="55%" size="4" /> : null}
							<TextLine h="18px" w="40" size="2.5" mt="1" />
						</Box>
						<Flex boxSize="8" align="center" justify="center" flexShrink={0}>
							<Bone boxSize="4" />
						</Flex>
					</Flex>

					<Box>
						<Disclosure label="Why this clip works" />
						<Disclosure label="Transcript">
							{/* Desk rows preview the opening of the transcript when collapsed. */}
							{isGallery ? null : (
								<Stack gap="0" pb="3" maxW="68ch">
									{["100%", "96%", "98%", "60%"].map((width) => (
										<TextLine key={width} h="25px" w={width} size="3" />
									))}
								</Stack>
							)}
						</Disclosure>
					</Box>

					<Flex data-clip-actions align="center" gap="2" pt="4" mt="auto">
						{ACTION_WIDTHS.map((width) => (
							<Bone key={width} h="9" borderRadius="control" style={{ width }} />
						))}
						<Flex boxSize="9" ms="auto" align="center" justify="center">
							<Bone boxSize="4" />
						</Flex>
					</Flex>
				</Stack>
			</Flex>
		</Box>
	);
}

/** A bone centered in a line box of the real text's height. */
function TextLine({
	h,
	w,
	size,
	mb,
	mt,
}: {
	h: string;
	w: string;
	size: string;
	mb?: string;
	mt?: string;
}) {
	return (
		<Flex h={h} align="center" mb={mb} mt={mt}>
			<Bone h={size} w={w} />
		</Flex>
	);
}

/** One ruled, full-width row in the card's detail list — ClipRow's DetailDisclosure. */
function Disclosure({ label, children }: { label: string; children?: ReactNode }) {
	return (
		<Box borderTopWidth="1px" borderColor="border.subtle">
			<Flex align="center" justify="space-between" py="2.5" fontSize="13px" fontWeight="500" color="fg.muted">
				{label}
				<Box color="fg.subtle">
					<ChevronDown size={14} />
				</Box>
			</Flex>
			{children}
		</Box>
	);
}
