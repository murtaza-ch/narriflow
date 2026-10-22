"use client";

import { Box, Flex, Skeleton, type SkeletonProps, Stack } from "@chakra-ui/react";
import { useSearchParams } from "next/navigation";

/** Real rendered tab widths (Clips includes its count badge). */
const TABS = [
	["clips", 93],
	["transcript", 90],
	["repurpose", 95],
	["dubbing", 79],
	["review", 71],
	["posts", 61],
	["analytics", 85],
	["activity", 74],
] as const;

/** Real action widths: Publish · Edit · Download/Render. */
const ACTION_WIDTHS = [70, 73, 93];

function Bone(props: SkeletonProps) {
	return <Skeleton variant="pulse" bg="bg.muted" borderRadius="l1" {...props} />;
}

/**
 * Project page placeholder — a 1:1 mirror of the heading, tabs, toolbar and
 * clip cards. The cards carry ClipRow's data attributes, so the workspace
 * stylesheet lays them out exactly like the real view: the three-column
 * gallery grid, or full-width desk rows.
 */
export function ProjectSkeleton() {
	const isGallery = useSearchParams().get("view") !== "desk";

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
					{/* Bones sit inside the real line boxes: 41px title, 18px meta. */}
					<Flex h="41px" align="center">
						<Bone h="8" w="min(560px, 85%)" borderRadius="l2" />
					</Flex>
					<Flex h="18px" align="center" gap="3">
						<Bone boxSize="4" />
						<Bone h="3" w="9" />
						<Bone h="3" w="20" />
					</Flex>
				</Stack>
				<Flex gap="2" flexShrink={0}>
					<Bone h="9" w="136px" borderRadius="l2" />
					<Bone h="9" w="85px" borderRadius="l2" />
					<Bone boxSize="9" borderRadius="l2" />
				</Flex>
			</Flex>

			{/* Tabs */}
			<Flex
				h="37px"
				gap="12px"
				align="center"
				overflow="hidden"
				borderBottomWidth="1px"
				borderColor="border.subtle"
			>
				{TABS.map(([tab, width]) => (
					<Box key={tab} px="3" flexShrink={0} style={{ width }}>
						<Bone h="3" w="full" />
					</Box>
				))}
			</Flex>

			<Box>
				{/* Toolbar — layout toggle, sort, filters · select all */}
				<Flex align="center" justify="space-between" gap="3" pb="3" mb="1">
					<Flex align="center" gap="3">
						<Bone h="9" w="86px" borderRadius="l2" />
						<Bone h="9" w="152px" borderRadius="l2" />
						<Bone boxSize="9" borderRadius="l2" />
					</Flex>
					<Flex align="center" gap="2">
						<Bone boxSize="4" />
						<Bone h="3" w="14" />
					</Flex>
				</Flex>

				<Stack data-clip-list gap="0" pt="3">
					{Array.from({ length: 6 }).map((_, index) => (
						<SkeletonClipCard key={index} isGallery={isGallery} />
					))}
				</Stack>
			</Box>
		</Stack>
	);
}

function SkeletonClipCard({ isGallery }: { isGallery: boolean }) {
	// Gallery pins selection and score to the card's top corners; desk rows
	// carry them on the preview — the same split ClipRow makes.
	const corners = (
		<>
			<Bone position="absolute" top={isGallery ? "4" : "2"} insetStart={isGallery ? "4" : "2"} boxSize="4" />
			<Stack position="absolute" top={isGallery ? "4" : "2"} insetEnd={isGallery ? "4" : "2"} gap="1.5" align="flex-end">
				<Bone h="5" w="7" />
				<Bone h="2" w="10" />
			</Stack>
		</>
	);

	return (
		<Box data-clip-card position="relative" borderRadius="l3" borderWidth="1px" borderColor="border.card" mb="4" p="5" bg="bg.panel">
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
					<Bone h="30px" w="196px" maxW="full" mx="auto" mt="2.5" borderRadius="l2" />
				</Box>

				<Stack data-clip-copy flex="1" minW="0" w="full" gap="4">
					<Flex align="flex-start" gap="2">
						<Stack gap="2.5" flex="1" minW="0">
							<Bone h="2.5" w="28" />
							<Bone h="5" w="72%" />
							<Bone h="2.5" w="40" />
						</Stack>
						<Bone boxSize="6" />
					</Flex>

					{/* "Why this clip works" and "Transcript" rows */}
					<Box>
						{[36, 22].map((width) => (
							<Flex
								key={width}
								align="center"
								justify="space-between"
								h="41px"
								borderTopWidth="1px"
								borderColor="border.subtle"
							>
								<Bone h="3" style={{ width: `${width}%` }} />
								<Bone boxSize="3" />
							</Flex>
						))}
					</Box>

					<Flex data-clip-actions align="center" gap="2" pt="4" mt="auto">
						{ACTION_WIDTHS.map((width) => (
							<Bone key={width} h="9" borderRadius="l2" style={{ width }} />
						))}
						<Bone boxSize="9" ms="auto" borderRadius="l2" />
					</Flex>
				</Stack>
			</Flex>
		</Box>
	);
}
