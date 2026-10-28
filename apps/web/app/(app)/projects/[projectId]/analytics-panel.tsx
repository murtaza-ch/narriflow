import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { Box, Flex, Grid, Stack, Text, VisuallyHidden } from "@chakra-ui/react";
import { BarChart3, Download, Film, Flame, Languages, Send } from "lucide-react";
import {
	performanceSyncAvailable,
	type AnalyticsSnapshot,
	type ClipSnapshot,
} from "@narriflow/validators";
import { describeCounts, formatCount } from "@/lib/performance-format";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";
import { PanelHeader } from "./panel-header";
import { SoftBar } from "./soft-bar";
import { EmptyState } from "@narriflow/ui/components/empty-state";

const integer = new Intl.NumberFormat("en-US");

function plural(count: number, noun: string) {
	return `${integer.format(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function SectionTitle({ children }: { children: ReactNode }) {
	return (
		<Text as="h3" fontSize="14px" fontWeight="550" color="fg">
			{children}
		</Text>
	);
}

function StatCard({
	icon,
	label,
	value,
	note,
}: {
	icon: ReactNode;
	label: string;
	value: number;
	note: string;
}) {
	return (
		<Stack gap="4" p="5" bg="bg.subtle" borderRadius="l3" minW="0">
			<Flex align="center" gap="2.5">
				<Flex
					boxSize="7"
					align="center"
					justify="center"
					borderRadius="full"
					bg="bg.soft"
					color="fg.muted"
					flexShrink={0}
					aria-hidden="true"
				>
					{icon}
				</Flex>
				<Text fontSize="13px" color="fg.muted">
					{label}
				</Text>
			</Flex>
			<Stack gap="1.5">
				<Text
					fontSize="32px"
					fontWeight="550"
					lineHeight="1"
					letterSpacing="-0.02em"
					fontVariantNumeric="tabular-nums"
					color="fg"
				>
					{integer.format(value)}
				</Text>
				<Text fontSize="12px" color="fg.subtle" truncate>
					{note}
				</Text>
			</Stack>
		</Stack>
	);
}

/**
 * Posts that went out against posts that failed, as one segmented bar. Both
 * count publish attempts that reached an outcome; "scheduled" is a separate
 * count (a post that was scheduled and then published is in both), so it is
 * not a segment.
 */
function PublishingCard({ posted, failed }: { posted: number; failed: number }) {
	const attempts = posted + failed;
	const successRate = Math.round((posted / attempts) * 100);
	return (
		<Stack gap="4" p="5" bg="bg.subtle" borderRadius="l3">
			<Flex align="baseline" justify="space-between" gap="3">
				<SectionTitle>Publishing</SectionTitle>
				<Text fontSize="13px" color="fg.muted" fontVariantNumeric="tabular-nums">
					<Text as="span" fontSize="20px" fontWeight="550" color="fg" letterSpacing="-0.01em">
						{successRate}%
					</Text>{" "}
					success
				</Text>
			</Flex>
			<Flex
				h="6px"
				gap="2px"
				bg="bg.soft"
				borderRadius="full"
				overflow="hidden"
				role="img"
				aria-label={`${plural(posted, "post")} published, ${integer.format(failed)} failed`}
			>
				{posted > 0 ? <Box flex={`${posted} 1 0`} bg="accent.solid" borderRadius="full" /> : null}
				{failed > 0 ? <Box flex={`${failed} 1 0`} bg="danger.solid" borderRadius="full" /> : null}
			</Flex>
			<Flex gap="6" wrap="wrap" fontSize="13px">
				<Flex align="center" gap="2">
					<Box boxSize="2" borderRadius="full" bg="accent.solid" aria-hidden="true" />
					<Text color="fg.muted">Published</Text>
					<Text fontVariantNumeric="tabular-nums" color="fg">
						{integer.format(posted)}
					</Text>
				</Flex>
				<Flex align="center" gap="2">
					<Box boxSize="2" borderRadius="full" bg="danger.solid" aria-hidden="true" />
					<Text color="fg.muted">Failed</Text>
					<Text fontVariantNumeric="tabular-nums" color={failed > 0 ? "danger.fg" : "fg"}>
						{integer.format(failed)}
					</Text>
				</Flex>
			</Flex>
		</Stack>
	);
}

function PublishingHint({ scheduled }: { scheduled: number }) {
	return (
		<Flex align="center" gap="3" px="5" py="4" bg="bg.subtle" borderRadius="l3">
			<Box color="fg.muted" display="flex" aria-hidden="true">
				<Send size={16} />
			</Box>
			<Text fontSize="13px" color="fg.muted">
				{scheduled > 0
					? "Results show here once a post goes out."
					: "Publish a clip to see how posts do here."}
			</Text>
		</Flex>
	);
}

const POST_COUNT_COLUMNS = [
	["views", "Views"],
	["likes", "Likes"],
	["comments", "Comments"],
	["shares", "Shares"],
] as const;

/**
 * The latest public counts of each published post, read back from its
 * platform. The totals come from the whole Project; the list shows its newest
 * posts.
 */
function PostPerformance({
	performance,
	clipTitle,
}: {
	performance: AnalyticsSnapshot["postPerformance"];
	clipTitle: (clipId: string | null) => string;
}) {
	const published = performance.posts;
	if (published.length === 0) return null;
	const columns = `minmax(180px, 1fr) 120px repeat(${POST_COUNT_COLUMNS.length}, 84px)`;
	return (
		<Stack gap="3">
			<Stack gap="1">
				<SectionTitle>Post performance</SectionTitle>
				{performance.measuredVideos > 0 ? (
					<Text fontSize="13px" color="fg.muted">
						{describeCounts(performance.totals)} across {performance.measuredVideos}{" "}
						{performance.measuredVideos === 1 ? "measured video" : "measured videos"}
					</Text>
				) : null}
			</Stack>
			<Box overflowX="auto">
				<Stack gap="1.5" minW="640px">
					<Grid templateColumns={columns} px="4" fontSize="12px" color="fg.subtle">
						<Text>Post</Text>
						<Text>Platform</Text>
						{POST_COUNT_COLUMNS.map(([key, label]) => (
							<Text key={key} textAlign="right">
								{label}
							</Text>
						))}
					</Grid>
					{published.map((post) => {
						const counts = post.latestMetrics;
						return (
							<Grid
								key={post.socialPostId}
								templateColumns={columns}
								alignItems="center"
								bg="bg.subtle"
								borderRadius="l2"
								px="4"
								py="3"
								transition="background 120ms ease"
								_hover={{ bg: "bg.soft" }}
							>
								<Text fontSize="13px" truncate>
									{clipTitle(post.clipId)}
								</Text>
								<Text fontSize="13px" color="fg.muted" truncate>
									{SOCIAL_PLATFORM_LABELS[post.platform]}
								</Text>
								{counts ? (
									POST_COUNT_COLUMNS.map(([key]) => (
										<Text
											key={key}
											fontSize="13px"
											fontVariantNumeric="tabular-nums"
											textAlign="right"
											color={counts[key] === null ? "fg.subtle" : "fg"}
										>
											{counts[key] === null ? "–" : formatCount(counts[key])}
										</Text>
									))
								) : (
									<Text
										gridColumn={`3 / span ${POST_COUNT_COLUMNS.length}`}
										fontSize="12px"
										color="fg.subtle"
										textAlign="right"
									>
										{performanceSyncAvailable(post.platform)
											? "First reading about an hour after posting"
											: "Not measured on this platform"}
									</Text>
								)}
							</Grid>
						);
					})}
				</Stack>
			</Box>
			<Text fontSize="12px" color="fg.subtle">
				Read from YouTube Shorts and TikTok about 1 hour, 1 day, 3 days, 7 days and 28 days after posting.
			</Text>
		</Stack>
	);
}

type ClipCountKey =
	| "downloadsOpened"
	| "socialScheduled"
	| "socialPosted"
	| "socialFailed"
	| "dubsCompleted"
	| "dubDownloadsOpened";

/** The counts shown beside a clip's renders; a column no clip has a count in is left out. */
const CLIP_COUNT_COLUMNS: ReadonlyArray<readonly [ClipCountKey, string]> = [
	["downloadsOpened", "Downloads"],
	["socialScheduled", "Scheduled"],
	["socialPosted", "Posted"],
	["socialFailed", "Failed"],
	["dubsCompleted", "Dubs"],
	["dubDownloadsOpened", "Dub downloads"],
];

export function AnalyticsPanel({
	analytics,
	clips,
}: {
	analytics: AnalyticsSnapshot;
	clips: ClipSnapshot[];
}) {
	const { totals } = analytics;
	const allZero =
		totals.rendersCompleted === 0 &&
		totals.downloadsOpened === 0 &&
		totals.dubsCompleted === 0 &&
		totals.dubDownloadsOpened === 0 &&
		totals.socialScheduled === 0 &&
		totals.socialPosted === 0 &&
		totals.socialFailed === 0;

	const header = (
		<PanelHeader
			icon={<BarChart3 size={20} />}
			title="Analytics"
			description="Counted by Narriflow from this project's renders, downloads, dubs and posts."
		/>
	);

	if (allZero) {
		return (
			<Stack gap="6">
				{header}
				<EmptyState
					icon={<BarChart3 />}
					title="No activity yet"
					description="Render, download or post a clip and the counts start here."
					action={
						<Button asChild size="sm" variant="subtle">
							<Link href={`/projects/${analytics.projectId}`}>Go to clips</Link>
						</Button>
					}
				/>
			</Stack>
		);
	}

	const clipById = new Map(clips.map((clip) => [clip.id, clip]));
	const clipTitle = (clipId: string | null) => {
		const clip = clipId ? clipById.get(clipId) : undefined;
		return clip ? (clip.title ?? clip.hookText ?? `Clip ${clip.index + 1}`) : "Removed clip";
	};

	const clipRows = analytics.byClip
		.map((row) => ({
			...row,
			total:
				row.rendersCompleted + CLIP_COUNT_COLUMNS.reduce((sum, [key]) => sum + row[key], 0),
		}))
		.filter((row) => row.total > 0)
		// Most-rendered first so the bars descend; clips tied on renders go by overall activity.
		.sort(
			(left, right) =>
				right.rendersCompleted - left.rendersCompleted || right.total - left.total,
		);
	const countColumns = CLIP_COUNT_COLUMNS.filter(([key]) =>
		clipRows.some((row) => row[key] > 0),
	);
	const showRenders = clipRows.some((row) => row.rendersCompleted > 0);
	const maxRenders = Math.max(1, ...clipRows.map((row) => row.rendersCompleted));
	const clipsRendered = analytics.byClip.filter((row) => row.rendersCompleted > 0).length;
	const clipGrid = [
		"minmax(200px, 1.4fr)",
		...(showRenders ? ["minmax(150px, 1fr)"] : []),
		...countColumns.map(() => "88px"),
	].join(" ");
	const clipGridMinWidth = 220 + (showRenders ? 170 : 0) + countColumns.length * 88;

	const publishAttempts = totals.socialPosted + totals.socialFailed;

	return (
		<Stack gap="8">
			{header}

			<Grid
				templateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" }}
				gap="3"
			>
				<StatCard
					icon={<Film size={14} />}
					label="Renders"
					value={totals.rendersCompleted}
					note={clipsRendered > 0 ? `across ${plural(clipsRendered, "clip")}` : "Completed renders"}
				/>
				<StatCard
					icon={<Download size={14} />}
					label="Downloads"
					value={totals.downloadsOpened}
					note="Download links opened"
				/>
				<StatCard
					icon={<Languages size={14} />}
					label="Dubs"
					value={totals.dubsCompleted}
					note={`${plural(totals.dubDownloadsOpened, "download")} opened`}
				/>
				<StatCard
					icon={<Send size={14} />}
					label="Posts published"
					value={totals.socialPosted}
					note={`${integer.format(totals.socialScheduled)} scheduled`}
				/>
			</Grid>

			{publishAttempts > 0 ? (
				<PublishingCard posted={totals.socialPosted} failed={totals.socialFailed} />
			) : (
				<PublishingHint scheduled={totals.socialScheduled} />
			)}

			<PostPerformance performance={analytics.postPerformance} clipTitle={clipTitle} />

			{clipRows.length > 0 ? (
				<Stack gap="3">
					<SectionTitle>Clips</SectionTitle>
					<Box overflowX="auto">
						<Stack gap="1.5" minW={`${clipGridMinWidth}px`}>
							<Grid templateColumns={clipGrid} px="4" gap="3" fontSize="12px" color="fg.subtle">
								<Text>Clip</Text>
								{showRenders ? <Text>Renders</Text> : null}
								{countColumns.map(([key, label]) => (
									<Text key={key} textAlign="right">
										{label}
									</Text>
								))}
							</Grid>
							{clipRows.map((row) => {
								const clip = clipById.get(row.clipId);
								return (
									<Grid
										key={row.clipId}
										templateColumns={clipGrid}
										gap="3"
										alignItems="center"
										bg="bg.subtle"
										borderRadius="l2"
										px="4"
										py="3"
										transition="background 120ms ease"
										_hover={{ bg: "bg.soft" }}
									>
										<Flex align="center" gap="2.5" minW="0">
											<Text fontSize="13px" color="fg" truncate>
												{clipTitle(row.clipId)}
											</Text>
											{clip ? (
												<Flex
													align="center"
													gap="1"
													flexShrink={0}
													px="2"
													py="1"
													borderRadius="full"
													bg="bg.soft"
													color="fg.muted"
													fontSize="11px"
													lineHeight="1"
													fontVariantNumeric="tabular-nums"
													title="Virality score"
												>
													<Flame size={11} aria-hidden="true" />
													<VisuallyHidden>Virality score </VisuallyHidden>
													{clip.viralityScore}
												</Flex>
											) : null}
										</Flex>
										{showRenders ? (
											<Flex align="center" gap="3">
												<SoftBar value={(row.rendersCompleted / maxRenders) * 100} />
												<Text
													w="6"
													flexShrink={0}
													fontSize="13px"
													textAlign="right"
													fontVariantNumeric="tabular-nums"
													color={row.rendersCompleted === 0 ? "fg.subtle" : "fg"}
												>
													{row.rendersCompleted}
												</Text>
											</Flex>
										) : null}
										{countColumns.map(([key]) => (
											<Text
												key={key}
												fontSize="13px"
												fontVariantNumeric="tabular-nums"
												textAlign="right"
												color={
													row[key] === 0
														? "fg.subtle"
														: key === "socialFailed"
															? "danger.fg"
															: "fg.muted"
												}
											>
												{row[key]}
											</Text>
										))}
									</Grid>
								);
							})}
						</Stack>
					</Box>
				</Stack>
			) : null}
		</Stack>
	);
}
