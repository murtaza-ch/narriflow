import type { ReactNode } from "react";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import {
	AlertTriangle,
	AudioLines,
	BarChart3,
	CalendarClock,
	Download,
	Film,
	Languages,
	Send,
} from "lucide-react";
import { Meter } from "@narriflow/ui/components/meter";
import {
	performanceSyncAvailable,
	type AnalyticsSnapshot,
	type ClipSnapshot,
} from "@narriflow/validators";
import { describeCounts, formatCount } from "@/lib/performance-format";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";
import { PanelHeader } from "./panel-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";

function MetricCard({
	icon,
	label,
	value,
	tone,
	children,
}: {
	icon: ReactNode;
	label: string;
	value: ReactNode;
	tone?: "danger";
	children?: ReactNode;
}) {
	return (
		<Stack
			gap="3"
			p="5"
			bg="bg.panel"
			borderWidth="1px"
			borderColor="border.card"
			borderRadius="l3"
		>
			<Flex align="center" justify="space-between" gap="3">
				<Text fontSize="13px" color="fg.muted">
					{label}
				</Text>
				<Box color={tone === "danger" ? "danger.fg" : "fg.muted"} aria-hidden="true">
					{icon}
				</Box>
			</Flex>
			<Text
				fontSize="30px"
				fontWeight="550"
				lineHeight="1"
				fontVariantNumeric="tabular-nums"
				color={tone === "danger" ? "danger.fg" : "fg"}
			>
				{value}
			</Text>
			{children}
		</Stack>
	);
}

const CLIP_COLUMNS = [
	["rendersCompleted", "Renders"],
	["downloadsOpened", "Downloads"],
	["socialScheduled", "Scheduled"],
	["socialPosted", "Posted"],
	["socialFailed", "Failed"],
	["dubsCompleted", "Dubs"],
] as const;

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
	titles,
}: {
	performance: AnalyticsSnapshot["postPerformance"];
	titles: Map<string, string>;
}) {
	const published = performance.posts;
	if (published.length === 0) return null;
	return (
		<Stack gap="3">
			<Text fontSize="14px" fontWeight="550">
				Post performance
			</Text>
			{performance.measuredVideos > 0 ? (
				<Text fontSize="13px" color="fg.muted">
					{describeCounts(performance.totals)} across {performance.measuredVideos}{" "}
					{performance.measuredVideos === 1 ? "measured video" : "measured videos"}
				</Text>
			) : null}
			<Box overflowX="auto">
				<Stack gap="1.5" minW="640px">
					{published.map((post) => {
						const counts = post.latestMetrics;
						return (
							<Grid
								key={post.socialPostId}
								templateColumns={`minmax(180px, 1fr) 120px repeat(${POST_COUNT_COLUMNS.length}, 84px)`}
								alignItems="center"
								bg="bg.subtle"
								borderRadius="l2"
								px="4"
								py="3"
							>
								<Text fontSize="13px" truncate>
									{(post.clipId && titles.get(post.clipId)) ?? "Removed clip"}
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
				Counts come from YouTube Shorts and TikTok at about 1 hour, 24 hours, 3 days, 7 days and 28 days
				after posting.
			</Text>
		</Stack>
	);
}

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
			description="Renders, downloads, dubs and social posts from this project, counted by Narriflow."
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
				/>
			</Stack>
		);
	}

	const publishAttempts = totals.socialPosted + totals.socialFailed;
	const successRate =
		publishAttempts > 0 ? Math.round((totals.socialPosted / publishAttempts) * 100) : null;

	const titles = new Map(
		clips.map((clip) => [clip.id, clip.title ?? clip.hookText ?? `Clip ${clip.index + 1}`]),
	);
	const clipRows = analytics.byClip
		.map((row) => ({
			...row,
			total: CLIP_COLUMNS.reduce((sum, [key]) => sum + row[key], 0) + row.dubDownloadsOpened,
		}))
		.filter((row) => row.total > 0)
		.sort((left, right) => right.total - left.total);


	return (
		<Stack gap="8">
			{header}

			<Stack gap="3">
				<Grid
					templateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" }}
					gap="4"
				>
					<MetricCard icon={<Film size={15} />} label="Completed renders" value={totals.rendersCompleted} />
					<MetricCard icon={<Download size={15} />} label="Download links opened" value={totals.downloadsOpened} />
					<MetricCard icon={<Languages size={15} />} label="Dubs completed" value={totals.dubsCompleted} />
					<MetricCard icon={<AudioLines size={15} />} label="Dub downloads" value={totals.dubDownloadsOpened} />
				</Grid>
			</Stack>

			<Stack gap="3">
				<Grid
					templateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" }}
					gap="4"
				>
					<MetricCard icon={<CalendarClock size={15} />} label="Scheduled" value={totals.socialScheduled} />
					<MetricCard icon={<Send size={15} />} label="Published" value={totals.socialPosted} />
					<MetricCard
						icon={<AlertTriangle size={15} />}
						label="Failed"
						value={totals.socialFailed}
						tone={totals.socialFailed > 0 ? "danger" : undefined}
					/>
					<MetricCard
						icon={<BarChart3 size={15} />}
						label="Publish success"
						value={successRate === null ? "—" : `${successRate}%`}
					>
						{successRate !== null ? (
							<Meter value={successRate} aria-label="Publish success rate" />
						) : (
							<Text fontSize="12px" color="fg.subtle">
								Shown after the first post goes out.
							</Text>
						)}
					</MetricCard>
				</Grid>
			</Stack>

			<PostPerformance performance={analytics.postPerformance} titles={titles} />

			{clipRows.length > 0 ? (
				<Box overflowX="auto">
					<Grid
						templateColumns={`minmax(220px, 1fr) repeat(${CLIP_COLUMNS.length}, 88px)`}
						minW="760px"
					>
						<Text px="5" py="2.5" fontSize="12px" color="fg.muted">
							Clip
						</Text>
						{CLIP_COLUMNS.map(([key, label]) => (
							<Text
								key={key}
								px="3"
								py="2.5"
								fontSize="12px"
								color="fg.muted"
								textAlign="right"
							>
								{label}
							</Text>
						))}
						{clipRows.map((row) => (
							<Box key={row.clipId} display="contents">
								<Text
									px="5"
									py="3"
									fontSize="13px"
									color="fg"
									truncate
									borderTopWidth="1px"
									borderColor="border.subtle"
								>
									{titles.get(row.clipId) ?? "Removed clip"}
								</Text>
								{CLIP_COLUMNS.map(([key]) => (
									<Text
										key={key}
										px="3"
										py="3"
										fontSize="13px"
										fontVariantNumeric="tabular-nums"
										textAlign="right"
										borderTopWidth="1px"
										borderColor="border.subtle"
										color={
											row[key] === 0
												? "fg.subtle"
												: key === "socialFailed"
													? "danger.fg"
													: "fg"
										}
									>
										{row[key] === 0 ? "–" : row[key]}
									</Text>
								))}
							</Box>
						))}
					</Grid>
				</Box>
			) : null}
		</Stack>
	);
}
