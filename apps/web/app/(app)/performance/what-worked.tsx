import Link from "next/link";
import { Box, Grid, Stack, Text } from "@chakra-ui/react";
import { TrendingUp } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Button } from "@narriflow/ui/components/button";
import type { GuidanceView, PerformanceGroup, PerformanceSummary } from "@narriflow/services";
import {
	PERFORMANCE_GUIDANCE_DIMENSIONS,
	PERFORMANCE_SYNC_SUPPORT,
	type SocialPlatform,
} from "@narriflow/validators";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";

const number = new Intl.NumberFormat("en-US");

function Tile({ label, value }: { label: string; value: string }) {
	return (
		<Stack gap="2" p="5" bg="bg.subtle" borderRadius="l3">
			<Text fontSize="13px" color="fg.muted">
				{label}
			</Text>
			<Text fontSize="28px" fontWeight="550" lineHeight="1" fontVariantNumeric="tabular-nums">
				{value}
			</Text>
		</Stack>
	);
}

const COLUMNS = "minmax(120px, 1fr) 56px 96px 96px 80px";

function GroupTable({
	title,
	groups,
	minimumGroupVideos,
	label,
}: {
	title: string;
	groups: PerformanceGroup[];
	minimumGroupVideos: number;
	label: (group: PerformanceGroup) => string;
}) {
	return (
		<Stack gap="2" p="5" bg="bg.subtle" borderRadius="l3" minW="0">
			<Text fontSize="14px" fontWeight="550">
				{title}
			</Text>
			{groups.length === 0 ? (
				<Text fontSize="13px" color="fg.subtle">
					No measured videos have this detail.
				</Text>
			) : (
				<Box overflowX="auto">
					<Grid templateColumns={COLUMNS} minW="440px" alignItems="center" columnGap="3">
						{["", "Videos", "Median views", "Total views", "Median likes"].map((heading, index) => (
							<Text
								key={heading || "name"}
								fontSize="12px"
								color="fg.muted"
								textAlign={index === 0 ? "left" : "right"}
								pb="2"
							>
								{heading}
							</Text>
						))}
						{groups.map((group) => (
							<Box key={group.key} display="contents">
								<Text fontSize="13px" py="2" truncate>
									{label(group)}
								</Text>
								<Text
									fontSize="13px"
									textAlign="right"
									fontVariantNumeric="tabular-nums"
									color={group.enough ? "fg" : "fg.subtle"}
									title={
										group.enough
											? undefined
											: `Fewer than ${minimumGroupVideos} videos, too few to compare`
									}
								>
									{group.videos}
								</Text>
								<Text fontSize="13px" textAlign="right" fontVariantNumeric="tabular-nums" color={group.enough ? "fg" : "fg.subtle"}>
									{number.format(group.views.median)}
								</Text>
								<Text fontSize="13px" textAlign="right" fontVariantNumeric="tabular-nums" color={group.enough ? "fg" : "fg.subtle"}>
									{number.format(group.views.total)}
								</Text>
								<Text fontSize="13px" textAlign="right" fontVariantNumeric="tabular-nums" color={group.enough ? "fg" : "fg.subtle"}>
									{group.likes ? number.format(group.likes.median) : "–"}
								</Text>
							</Box>
						))}
					</Grid>
				</Box>
			)}
		</Stack>
	);
}

function liftText(lift: number) {
	return `${Number(lift.toFixed(2))}x`;
}

/** What Narriflow has learned about this audience, and how it is used. */
function Guidance({ guidance }: { guidance: GuidanceView }) {
	const computed = guidance.computedAt
		? new Date(guidance.computedAt).toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				timeZone: "UTC",
			})
		: null;
	return (
		<Stack gap="3" p="5" bg="bg.subtle" borderRadius="l3" data-guidance={guidance.applied ? "applied" : "idle"}>
			<Text fontSize="14px" fontWeight="550">
				Your audience data
			</Text>
			{guidance.qualifies ? (
				<>
					<Text fontSize="13px" color="fg.muted" maxW="68ch">
						{guidance.applied
							? "Narriflow is using this to pick clips."
							: "Narriflow is not using this, because it is switched off in Workspace settings."}{" "}
						Computed {computed} among {guidance.totalPosts} clips you posted from Narriflow in the last{" "}
						{guidance.windowDays} days. Each video is compared with a typical post on its own platform, so
						a bigger audience on one platform never counts as a better clip. A group's lift is its median
						against that, pulled toward 1x when it has few clips.
					</Text>
					<Text fontSize="13px" color="fg.muted" maxW="68ch">
						Typical post at 7 days:{" "}
						{guidance.platforms
							.map((entry) => `${SOCIAL_PLATFORM_LABELS[entry.platform]} ${number.format(entry.medianViews)} views`)
							.join(", ")}
						.
					</Text>
					<Stack gap="1">
						{guidance.groups.map((group) => (
							<Box key={`${group.dimension}:${group.key}`} display="flex" gap="3" alignItems="baseline">
								<Text fontSize="13px" minW="0" flex="1" truncate>
									{PERFORMANCE_GUIDANCE_DIMENSIONS[group.dimension]}: {group.label}
								</Text>
								<Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums">
									{group.posts} clips
								</Text>
								<Text fontSize="13px" fontWeight="550" minW="44px" textAlign="right" fontVariantNumeric="tabular-nums">
									{liftText(group.lift)}
								</Text>
							</Box>
						))}
					</Stack>
					<Text fontSize="12px" color="fg.subtle" maxW="68ch">
						Moment detection is told the two strongest groups and the weakest one, as a tiebreaker between
						similar moments. When finishing picks which clips to export, each clip's score is multiplied by a
						factor from {guidance.minimumFactor} to {guidance.maximumFactor} based on the groups it falls in, and a
						clip only moves ahead of another whose score is within {guidance.maximumScoreGap} points. Hook
						strength is not a group, because it is already part of the score. Scores themselves never
						change, and every pick shows the factor it used.
					</Text>
				</>
			) : (
				<Text fontSize="13px" color="fg.muted" maxW="68ch">
					Not enough data yet.
					{guidance.totalPosts !== null ? ` ${guidance.totalPosts} clips counted at the last check.` : ""} Only clips
					you posted from Narriflow to YouTube Shorts and TikTok are measured, over the last {guidance.windowDays}{" "}
					days. Narriflow starts from {guidance.minimumWorkspacePosts} clips with a 7-day reading, on platforms with at
					least {guidance.minimumPlatformPosts} measured posts, and a group counts once it has at least{" "}
					{guidance.minimumGroupPosts} clips. Until then clips are picked on their own score.
				</Text>
			)}
			<Link href="/settings/workspace">
				<Text
					as="span"
					fontSize="12px"
					color="fg.accent"
					textDecoration="underline"
					textUnderlineOffset="3px"
				>
					Use my performance data to pick clips: {guidance.enabled ? "on" : "off"}
				</Text>
			</Link>
		</Stack>
	);
}

function unmeasuredPlatforms() {
	return (Object.keys(PERFORMANCE_SYNC_SUPPORT) as SocialPlatform[])
		.filter((platform) => !PERFORMANCE_SYNC_SUPPORT[platform].available)
		.map((platform) => SOCIAL_PLATFORM_LABELS[platform]);
}

function Summary({ summary, guidance }: { summary: PerformanceSummary; guidance: GuidanceView }) {
	return (
		<Stack gap="6">
			<Grid templateColumns={{ base: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" }} gap="3">
				<Tile label="Videos measured" value={number.format(summary.measuredVideos)} />
				<Tile label="Total views" value={number.format(summary.totals.views)} />
				<Tile label="Total likes" value={number.format(summary.totals.likes)} />
				<Tile label="Total comments" value={number.format(summary.totals.comments)} />
			</Grid>

			{summary.enough ? null : (
				<Stack gap="1" p="5" bg="bg.subtle" borderRadius="l3" role="status">
					<Text fontSize="14px" fontWeight="550">
						Too little data to compare yet
					</Text>
					<Text fontSize="13px" color="fg.muted" maxW="64ch">
						{summary.measuredVideos === 0
							? "No video has been measured yet."
							: `${summary.measuredVideos} ${summary.measuredVideos === 1 ? "video has" : "videos have"} been measured.`}{" "}
						Comparisons are worth reading from {summary.minimumVideos} videos, and a group of fewer than{" "}
						{summary.minimumGroupVideos} is shown dimmed because it says little on its own.
					</Text>
				</Stack>
			)}

			{summary.waitingVideos > 0 ? (
				<Text fontSize="13px" color="fg.muted">
					{summary.waitingVideos} {summary.waitingVideos === 1 ? "video is" : "videos are"} younger than 7 days
					and will join the comparison when its 7-day reading arrives.
				</Text>
			) : null}

			<Guidance guidance={guidance} />

			{summary.measuredVideos > 0 ? (
				<Grid templateColumns={{ base: "minmax(0, 1fr)", xl: "repeat(2, minmax(0, 1fr))" }} gap="3">
					{summary.dimensions.map((dimension) => (
						<GroupTable
							key={dimension.id}
							title={dimension.title}
							groups={dimension.groups}
							minimumGroupVideos={summary.minimumGroupVideos}
							label={(group) =>
								dimension.id === "platform"
									? SOCIAL_PLATFORM_LABELS[group.key as SocialPlatform]
									: group.label
							}
						/>
					))}
				</Grid>
			) : null}
		</Stack>
	);
}

/** The empty page's next step: post a clip, connect an account first, or ask someone who can. */
export type EmptyNextStep = "publish" | "connect" | "ask" | null;

export function WhatWorked({
	summary,
	guidance,
	emptyNextStep = null,
}: {
	summary: PerformanceSummary;
	guidance: GuidanceView;
	emptyNextStep?: EmptyNextStep;
}) {
	const empty = summary.measuredVideos === 0 && summary.waitingVideos === 0;
	return (
		<Stack gap="8">
			<PageHeader
				title="What worked"
				description="Views and likes read back from YouTube Shorts and TikTok. Every video is compared at 7 days after posting, so older and newer posts line up."
			/>
			{empty ? (
				<EmptyState
					icon={<TrendingUp />}
					title="No posts measured yet"
					description={`Publish a clip to YouTube Shorts or TikTok. Its 7-day reading arrives a week later.${
						emptyNextStep === "ask" ? " Ask a workspace owner or admin to connect one of those accounts." : ""
					}`}
					action={
						emptyNextStep === "publish" ? (
							<Button size="sm" variant="subtle" asChild>
								<Link href="/projects">Browse projects</Link>
							</Button>
						) : emptyNextStep === "connect" ? (
							<Button size="sm" variant="subtle" asChild>
								<Link href="/settings/social-accounts">Connect an account</Link>
							</Button>
						) : undefined
					}
				/>
			) : (
				<Summary summary={summary} guidance={guidance} />
			)}
			<Text fontSize="12px" color="fg.subtle">
				{unmeasuredPlatforms().join(", ")} posts aren't measured yet. Totals and medians use each
				video's 7-day reading, and they keep counting videos whose Project was deleted.
			</Text>
		</Stack>
	);
}
