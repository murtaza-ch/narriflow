import Link from "next/link";
import { Box, Flex, Grid, Image, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, Check, ChevronDown, Clock, Eye, Film, Heart, Lightbulb, MessageCircle, Sparkles, TrendingUp, Trophy } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Button } from "@narriflow/ui/components/button";
import {
	PERFORMANCE_GUIDANCE_DIMENSIONS,
	PERFORMANCE_SYNC_SUPPORT,
	type SocialPlatform,
} from "@narriflow/validators";
import type { GuidanceView, PerformanceGroupView as PerformanceGroup, PerformanceSummaryView as PerformanceSummary } from "@/lib/publishing-client";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";
import { BrandTile } from "../integrations/_components/brand-tile";

const number = new Intl.NumberFormat("en-US");

function Tile({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
	return (
		<Stack gap="4" p="5" bg="bg.subtle" borderRadius="l3">
			<Flex align="center" justify="space-between" gap="2">
				<Text fontSize="13px" color="fg.muted">
					{label}
				</Text>
				<Flex boxSize="8" borderRadius="full" bg="bg.soft" color="fg.muted" align="center" justify="center" aria-hidden>
					{icon}
				</Flex>
			</Flex>
			<Text fontSize="30px" fontWeight="550" lineHeight="1" letterSpacing="-0.02em" fontVariantNumeric="tabular-nums">
				{value}
			</Text>
		</Stack>
	);
}

/** A thin bar showing a value against the largest in its set. */
function Bar({ share, muted = false }: { share: number; muted?: boolean }) {
	return (
		<Box h="4px" mt="1.5" borderRadius="full" bg="bg.soft" overflow="hidden">
			<Box h="full" borderRadius="full" bg={muted ? "fg.subtle" : "accent.solid"} opacity={muted ? 0.5 : 1} style={{ width: `${Math.max(3, Math.round(share * 100))}%` }} />
		</Box>
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
		<Stack gap="3" p="5" bg="bg.subtle" borderRadius="l3" minW="0">
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
								<Box py="2" minW="0">
									<Text fontSize="13px" truncate>
										{label(group)}
									</Text>
									<Bar share={group.views.median / Math.max(1, ...groups.map((entry) => entry.views.median))} muted={!group.enough} />
								</Box>
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

/** A group's lift as a bar from the 1x line: right and accent above typical, left and muted below. */
function LiftBar({ lift, maxLift }: { lift: number; maxLift: number }) {
	const reach = Math.min(1, Math.abs(lift - 1) / Math.max(0.01, maxLift - 1));
	const above = lift >= 1;
	return (
		<Flex w={{ base: "24", md: "40" }} h="6px" flexShrink={0} align="center" aria-hidden>
			<Flex flex="1" justify="flex-end" h="full">
				{above ? null : <Box h="full" borderStartRadius="full" bg="fg.subtle" style={{ width: `${Math.max(4, reach * 100)}%` }} />}
			</Flex>
			<Box w="2px" h="12px" bg="border.emphasized" flexShrink={0} />
			<Flex flex="1" h="full">
				{above ? <Box h="full" borderEndRadius="full" bg="accent.solid" style={{ width: `${Math.max(4, reach * 100)}%` }} /> : null}
			</Flex>
		</Flex>
	);
}

/** Long explanations folded away behind one line; the page stays scannable. */
function HowItWorks({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Box as="details" css={{ "&[open] > summary svg": { transform: "rotate(180deg)" } }}>
			<Box as="summary" display="inline-flex" alignItems="center" gap="1.5" cursor="pointer" fontSize="12.5px" fontWeight="500" color="fg.muted" listStyle="none" _hover={{ color: "fg" }} css={{ "&::-webkit-details-marker": { display: "none" } }}>
				{title}
				<ChevronDown size={13} style={{ transition: "transform 150ms ease" }} />
			</Box>
			<Stack gap="2" mt="3" fontSize="12.5px" color="fg.muted" maxW="72ch" lineHeight="1.6">
				{children}
			</Stack>
		</Box>
	);
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
	const maxLift = Math.max(1.5, ...guidance.groups.map((group) => Math.max(group.lift, 1 / Math.max(0.01, group.lift))));
	return (
		<Stack gap="4" p="5" bg="bg.subtle" borderRadius="l3" data-guidance={guidance.applied ? "applied" : "idle"}>
			<Flex align="center" justify="space-between" gap="3" wrap="wrap">
				<Flex align="center" gap="2.5">
					<Flex boxSize="8" borderRadius="full" bg="accent.subtle" color="accent.fg" align="center" justify="center" aria-hidden>
						<Sparkles size={15} />
					</Flex>
					<Text fontSize="14px" fontWeight="550">
						Your audience data
					</Text>
				</Flex>
				<Link href="/settings/workspace">
					<Flex
						as="span"
						align="center"
						gap="1.5"
						h="7"
						px="2.5"
						borderRadius="full"
						bg={guidance.enabled ? "accent.subtle" : "bg.soft"}
						color={guidance.enabled ? "accent.fg" : "fg.muted"}
						fontSize="12px"
						fontWeight="500"
					>
						<Box boxSize="1.5" borderRadius="full" bg={guidance.enabled ? "accent.solid" : "fg.subtle"} />
						Use my performance data to pick clips: {guidance.enabled ? "on" : "off"}
					</Flex>
				</Link>
			</Flex>
			{guidance.qualifies ? (
				<>
					<Text fontSize="13px" color="fg.muted" maxW="68ch">
						{guidance.applied
							? "Narriflow is using this to pick clips."
							: "Narriflow is not using this, because it is switched off in Workspace settings."}{" "}
						Computed {computed} among {guidance.totalPosts} clips you posted from Narriflow in the last{" "}
						{guidance.windowDays} days.
					</Text>
					<Stack gap="2.5">
						{guidance.groups.map((group) => (
							<Flex key={`${group.dimension}:${group.key}`} gap="3" align="center">
								<Text fontSize="13px" minW="0" flex="1" truncate>
									{PERFORMANCE_GUIDANCE_DIMENSIONS[group.dimension]}: {group.label}
								</Text>
								<Text fontSize="12px" color="fg.subtle" fontVariantNumeric="tabular-nums" display={{ base: "none", sm: "block" }}>
									{group.posts} clips
								</Text>
								<LiftBar lift={group.lift} maxLift={maxLift} />
								<Text fontSize="13px" fontWeight="550" minW="44px" textAlign="right" fontVariantNumeric="tabular-nums" color={group.lift >= 1 ? "accent.fg" : "fg.muted"}>
									{liftText(group.lift)}
								</Text>
							</Flex>
						))}
					</Stack>
					<HowItWorks title="How this is measured and used">
						<Text>
							Each video is compared with a typical post on its own platform, so a bigger audience on one platform
							never counts as a better clip. A group&apos;s lift is its median against that, pulled toward 1x when it has
							few clips.
						</Text>
						<Text>
							Typical post at 7 days:{" "}
							{guidance.platforms
								.map((entry) => `${SOCIAL_PLATFORM_LABELS[entry.platform]} ${number.format(entry.medianViews)} views`)
								.join(", ")}
							.
						</Text>
						<Text>
							Moment detection is told the two strongest groups and the weakest one, as a tiebreaker between
							similar moments. When finishing picks which clips to export, each clip&apos;s score is multiplied by a
							factor from {guidance.minimumFactor} to {guidance.maximumFactor} based on the groups it falls in, and a
							clip only moves ahead of another whose score is within {guidance.maximumScoreGap} points. Hook
							strength is not a group, because it is already part of the score. Scores themselves never
							change, and every pick shows the factor it used.
						</Text>
					</HowItWorks>
				</>
			) : (
				<>
					<Text fontSize="13px" color="fg.muted" maxW="68ch">
						Not enough data yet.
						{guidance.totalPosts !== null ? ` ${guidance.totalPosts} clips counted at the last check.` : ""} Until then clips
						are picked on their own score.
					</Text>
					<Progress value={guidance.totalPosts ?? 0} goal={guidance.minimumWorkspacePosts} label="clips with a 7-day reading" />
					<HowItWorks title="When it starts">
						<Text>
							Only clips you posted from Narriflow to YouTube Shorts and TikTok are measured, over the last{" "}
							{guidance.windowDays} days. Narriflow starts from {guidance.minimumWorkspacePosts} clips with a 7-day
							reading, on platforms with at least {guidance.minimumPlatformPosts} measured posts, and a group counts
							once it has at least {guidance.minimumGroupPosts} clips.
						</Text>
					</HowItWorks>
				</>
			)}
		</Stack>
	);
}

/** How far a count is toward the number where a feature starts. */
function Progress({ value, goal, label }: { value: number; goal: number; label: string }) {
	const share = goal > 0 ? Math.min(1, value / goal) : 1;
	return (
		<Stack gap="1.5" maxW="420px">
			<Flex justify="space-between" fontSize="12px" color="fg.muted">
				<Text>{label}</Text>
				<Text fontVariantNumeric="tabular-nums" color="fg">
					{Math.min(value, goal)} / {goal}
				</Text>
			</Flex>
			<Box h="6px" borderRadius="full" bg="bg.soft" overflow="hidden">
				<Box h="full" borderRadius="full" bg="accent.solid" animation="meter-fill" style={{ width: `${Math.max(2, share * 100)}%` }} />
			</Box>
		</Stack>
	);
}

/** Every platform with whether its posts are read back, as logos. */
function PlatformCoverage() {
	const platforms = Object.keys(PERFORMANCE_SYNC_SUPPORT) as SocialPlatform[];
	return (
		<Flex gap="2" wrap="wrap" align="center">
			{platforms.map((platform) => {
				const measured = PERFORMANCE_SYNC_SUPPORT[platform].available;
				return (
					<Flex key={platform} align="center" gap="2" h="9" ps="1.5" pe="3" borderRadius="full" bg="bg.subtle" opacity={measured ? 1 : 0.75}>
						<BrandTile brand={platform} size="sm" filter={measured ? undefined : "grayscale(1)"} />
						<Text fontSize="12.5px" fontWeight="500" color={measured ? "fg" : "fg.muted"}>
							{SOCIAL_PLATFORM_LABELS[platform]}
						</Text>
						<Text fontSize="11.5px" color={measured ? "accent.fg" : "fg.subtle"}>
							{measured ? "Measured" : "Not yet"}
						</Text>
					</Flex>
				);
			})}
		</Flex>
	);
}

function Summary({ summary, guidance }: { summary: PerformanceSummary; guidance: GuidanceView }) {
	return (
		<Stack gap="6">
			<Grid templateColumns={{ base: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" }} gap="3">
				<Tile label="Videos measured" value={number.format(summary.measuredVideos)} icon={<Film size={15} />} />
				<Tile label="Total views" value={number.format(summary.totals.views)} icon={<Eye size={15} />} />
				<Tile label="Total likes" value={number.format(summary.totals.likes)} icon={<Heart size={15} />} />
				<Tile label="Total comments" value={number.format(summary.totals.comments)} icon={<MessageCircle size={15} />} />
			</Grid>

			{summary.enough ? null : (
				<Stack gap="3" p="5" bg="bg.subtle" borderRadius="l3" role="status">
					<Stack gap="1">
						<Text fontSize="14px" fontWeight="550">
							Too little data to compare yet
						</Text>
						<Text fontSize="13px" color="fg.muted" maxW="64ch">
							{summary.measuredVideos === 0
								? "No video has been measured yet."
								: `${summary.measuredVideos} ${summary.measuredVideos === 1 ? "video has" : "videos have"} been measured.`}{" "}
							Comparisons get useful from {summary.minimumVideos}; groups under {summary.minimumGroupVideos} are dimmed.
						</Text>
					</Stack>
					<Progress value={summary.measuredVideos} goal={summary.minimumVideos} label="videos measured" />
				</Stack>
			)}

			{summary.waitingVideos > 0 ? (
				<Flex align="center" gap="2" alignSelf="flex-start" px="3" py="2" borderRadius="full" bg="bg.subtle" fontSize="12.5px" color="fg.muted">
					<Clock size={13} aria-hidden />
					<Text>
						{summary.waitingVideos} {summary.waitingVideos === 1 ? "video is" : "videos are"} younger than 7 days and will join soon.
					</Text>
				</Flex>
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
			<Box animation="fade-up" animationFillMode="backwards">
				<PageHeader title="What worked" description="How your clips perform on YouTube Shorts and TikTok." />
			</Box>
			<Stack gap="6" animation="fade-up" animationFillMode="backwards" style={{ animationDelay: "60ms" }}>
				{empty ? <EmptyHero nextStep={emptyNextStep} /> : <Summary summary={summary} guidance={guidance} />}
				<Stack gap="2.5">
					<Flex align="center" gap="2" wrap="wrap">
						<Text fontSize="13px" fontWeight="500" color="fg.muted">
							Platforms
						</Text>
						<Hint>Each video is read 7 days after posting, so old and new posts compare fairly.</Hint>
					</Flex>
					<PlatformCoverage />
					{empty ? null : (
						<Text fontSize="12px" color="fg.subtle">
							Totals keep counting videos whose Project was deleted.
						</Text>
					)}
				</Stack>
			</Stack>
		</Stack>
	);
}

/** A one-line tip in a soft pill. */
function Hint({ children }: { children: ReactNode }) {
	return (
		<Flex align="center" gap="1.5" h="6" px="2.5" borderRadius="full" bg="bg.soft" fontSize="11.5px" color="fg.muted">
			<Lightbulb size={12} aria-hidden />
			<Text>{children}</Text>
		</Flex>
	);
}

/** The empty page: three steps to a first reading, beside a sample of what this page becomes. */
function EmptyHero({ nextStep }: { nextStep: EmptyNextStep }) {
	const connected = nextStep === "publish";
	const action =
		nextStep === "publish" ? (
			<Button asChild>
				<Link href="/projects">
					Browse projects <ArrowRight size={14} />
				</Link>
			</Button>
		) : nextStep === "connect" ? (
			<Button asChild>
				<Link href="/settings/social-accounts">
					Connect an account <ArrowRight size={14} />
				</Link>
			</Button>
		) : null;
	const steps = [
		{ title: "Connect YouTube or TikTok", done: connected },
		{ title: "Publish a clip from Narriflow", done: false },
		{ title: "See its results 7 days later", done: false },
	];
	return (
		<Grid templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) minmax(0, 1.15fr)" }} bg="bg.subtle" borderRadius="l3" overflow="hidden">
			<Stack gap="6" p={{ base: "6", md: "8" }} justify="center">
				<Stack gap="2">
					<Text as="h2" textStyle="title" fontSize={{ base: "22px", md: "26px" }} letterSpacing="-0.02em">
						No posts measured yet
					</Text>
					<Text fontSize="14px" color="fg.muted" maxW="40ch">
						Post a clip and see how it did a week later.
						{nextStep === "ask" ? " Ask a workspace owner or admin to connect one of those accounts." : ""}
					</Text>
				</Stack>
				<Stack as="ol" gap="3" listStyleType="none" m="0" p="0">
					{steps.map((step, index) => (
						<Flex as="li" key={step.title} align="center" gap="3">
							<Flex
								boxSize="7"
								flexShrink={0}
								borderRadius="full"
								align="center"
								justify="center"
								fontSize="12px"
								fontWeight="600"
								bg={step.done ? "accent.solid" : "bg.soft"}
								color={step.done ? "accent.contrast" : "fg"}
							>
								{step.done ? <Check size={13} strokeWidth={3} /> : index + 1}
							</Flex>
							<Text fontSize="13.5px" color={step.done ? "fg.muted" : "fg"} textDecoration={step.done ? "line-through" : undefined}>
								{step.title}
							</Text>
						</Flex>
					))}
				</Stack>
				{action ? <Box>{action}</Box> : null}
			</Stack>
			<SamplePreview />
		</Grid>
	);
}

/** A 7-day view curve for the sample: cumulative views rising fast, then leveling off. */
const SAMPLE_CURVE = [0, 0.38, 0.6, 0.74, 0.83, 0.9, 0.95, 1];

function SampleChart() {
	const width = 320;
	const height = 84;
	const points = SAMPLE_CURVE.map((value, index) => [(index / (SAMPLE_CURVE.length - 1)) * width, height - value * (height - 8)] as const);
	const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
	const gradient = "sample-area";
	return (
		<Box color="accent.solid" w="full" h="84px">
		<svg viewBox={`0 0 ${width} ${height}`} width="100%" height="84" preserveAspectRatio="none" overflow="visible" aria-hidden="true">
			<defs>
				<linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
					<stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
					<stop offset="100%" stopColor="currentColor" stopOpacity="0" />
				</linearGradient>
			</defs>
			<path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${gradient})`} />
			<path d={line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
			<circle cx={points[points.length - 1]![0]} cy={points[points.length - 1]![1]} r="3.5" fill="currentColor" />
		</svg>
		</Box>
	);
}

/** Made-up numbers in the page's own layout, so an empty page shows what it will become. */
function SamplePreview() {
	const bars = [
		{ label: "Story", value: 0.92 },
		{ label: "Humor", value: 0.74 },
		{ label: "How-to", value: 0.51 },
	];
	return (
		<Box
			position="relative"
			p={{ base: "6", md: "8" }}
			pt={{ md: "12" }}
			bg="bg.muted"
			aria-hidden
			display={{ base: "none", md: "block" }}
			overflow="hidden"
			style={{ backgroundImage: "radial-gradient(120% 80% at 100% 0%, var(--chakra-colors-accent-subtle) 0%, transparent 60%)" }}
		>
			<Flex position="absolute" top="4" right="4" h="6" px="2.5" align="center" borderRadius="full" bg="bg.soft" fontSize="11.5px" fontWeight="500" color="fg.muted">
				Sample
			</Flex>
			<Stack gap="3" pointerEvents="none" userSelect="none">
				{/* Top clip */}
				<Flex gap="3.5" p="3" bg="bg.subtle" borderRadius="l2" align="center">
					<Box position="relative" w="54px" flexShrink={0} aspectRatio={9 / 16} borderRadius="8px" overflow="hidden" bg="studio.canvas">
						<Image src="/landing/moment-podcast-1.webp" alt="" w="full" h="full" objectFit="cover" />
						<Text position="absolute" insetX="1" bottom="2.5" textAlign="center" fontSize="6px" fontWeight="800" lineHeight="1.1" color="white" textTransform="uppercase" textShadow="0 1px 2px rgba(0,0,0,.7)">
							The one habit
						</Text>
					</Box>
					<Stack gap="1" minW="0" flex="1">
						<Flex align="center" gap="1.5" fontSize="11.5px" color="fg.muted">
							<Trophy size={12} />
							Top clip this month
						</Flex>
						<Text fontSize="13.5px" fontWeight="550" truncate>
							The one habit that grew our show
						</Text>
						<Flex align="center" gap="2" fontSize="12px">
							<Text fontWeight="550" fontVariantNumeric="tabular-nums">12.4K views</Text>
							<Flex align="center" gap="0.5" px="1.5" h="5" borderRadius="6px" bg="accent.subtle" color="accent.fg" fontWeight="600">
								<TrendingUp size={11} /> 2.3x
							</Flex>
						</Flex>
					</Stack>
				</Flex>
				{/* 7-day curve */}
				<Stack gap="2" p="4" bg="bg.subtle" borderRadius="l2">
					<Flex justify="space-between" align="baseline">
						<Text fontSize="12.5px" fontWeight="550">
							Views, first 7 days
						</Text>
						<Text fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
							48.2K
						</Text>
					</Flex>
					<SampleChart />
					<Flex justify="space-between" fontSize="10.5px" color="fg.subtle">
						<Text>Day 1</Text>
						<Text>Day 7</Text>
					</Flex>
				</Stack>
				{/* Category bars */}
				<Stack gap="2.5" p="4" bg="bg.subtle" borderRadius="l2">
					<Text fontSize="12.5px" fontWeight="550">
						Views by category
					</Text>
					{bars.map((bar, index) => (
						<Flex key={bar.label} align="center" gap="3">
							<Text fontSize="12px" color="fg.muted" w="14" flexShrink={0}>
								{bar.label}
							</Text>
							<Box flex="1" h="8px" borderRadius="full" bg="bg.soft" overflow="hidden">
								<Box
									h="full"
									borderRadius="full"
									bg={index === 0 ? "accent.solid" : "accent.muted"}
									animation="meter-fill"
									style={{ width: `${bar.value * 100}%`, animationDelay: `${120 + index * 80}ms` }}
								/>
							</Box>
						</Flex>
					))}
				</Stack>
			</Stack>
		</Box>
	);
}
