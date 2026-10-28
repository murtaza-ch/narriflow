"use client";

import { SocialPostLinks } from "@/lib/social-post-links";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, Columns3, Globe, Inbox, List as ListIcon, Plus, X } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Button } from "@narriflow/ui/components/button";
import { toaster } from "@narriflow/ui/components/toaster";
import { invalidatePublishing } from "@narriflow/api-client/publishing";
import type { WorkspaceScope } from "@narriflow/api-client";
import type { SocialPlatform, SocialPostStatus } from "@narriflow/validators";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import {
	apiFailureMessage,
	publishingApi,
	publishingQueries,
	type CalendarPost,
	type CalendarWindowQuery,
} from "@/lib/publishing-client";
import { PublishingLoadError } from "@/lib/publishing-load-error";
import {
	describeSocialPost,
	SOCIAL_PLATFORM_LABELS,
	SOCIAL_POST_STATUS_LABELS,
	type SocialPostTone,
} from "@/lib/social-post-status";
import { BrandTile } from "../integrations/_components/brand-tile";
import { CalendarFilters } from "./calendar-filters";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { LockedButton } from "../_components/upgrade";
import { useWorkspaceBootstrap } from "../_components/usage";
import CalendarLoading from "./loading";

type CalendarView = "month" | "week" | "list";

function statusStripe(tone: SocialPostTone) {
	if (tone === "danger") return "danger.solid";
	if (tone === "success" || tone === "accent") return "accent.solid";
	if (tone === "warning") return "warning.solid";
	return "fg.subtle";
}

function calendarWindow(
	view: CalendarView,
	value?: string,
	dateValue?: string,
) {
	const parsed =
		value && /^\d{4}-\d{2}$/.test(value)
			? new Date(`${value}-01T00:00:00.000Z`)
			: new Date();
	if (view === "week") {
		const selected =
			dateValue && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)
				? new Date(`${dateValue}T00:00:00.000Z`)
				: new Date();
		const from = new Date(
			Date.UTC(
				selected.getUTCFullYear(),
				selected.getUTCMonth(),
				selected.getUTCDate(),
			),
		);
		const mondayOffset = (from.getUTCDay() + 6) % 7;
		from.setUTCDate(from.getUTCDate() - mondayOffset);
		const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
		return {
			from,
			to,
			label: `${from.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}–${to.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`,
		};
	}
	const from = new Date(
		Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1),
	);
	const to = new Date(
		Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 1) - 1,
	);
	return {
		from,
		to,
		label: from.toLocaleDateString("en-US", {
			month: "long",
			year: "numeric",
			timeZone: "UTC",
		}),
	};
}

function dateKey(value: Date | string, timeZone: string) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
			.formatToParts(new Date(value))
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, part.value]),
	);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatInTimezone(value: string, timeZone: string) {
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(new Date(value));
}

function calendarDays(from: Date, to: Date, padMonth: boolean) {
	const first = new Date(from);
	const last = new Date(to);
	if (padMonth) {
		first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
		last.setUTCDate(
			last.getUTCDate() + ((7 - ((last.getUTCDay() + 6) % 7) - 1) % 7),
		);
	}
	const days: Date[] = [];
	for (
		const day = new Date(first);
		day <= last;
		day.setUTCDate(day.getUTCDate() + 1)
	) {
		days.push(new Date(day));
	}
	return days;
}

const STATUSES: SocialPostStatus[] = [
	"draft",
	"preparing_video",
	"scheduled",
	"publishing",
	"processing",
	"reconciling",
	"posted",
	"inbox_delivered",
	"failed",
	"needs_attention",
	"cancelled",
];
const PLATFORMS: SocialPlatform[] = ["tiktok", "youtube_shorts", "instagram_reels", "linkedin", "x"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cancels a post that has not gone out yet, then refreshes everything publishing shows. */
function CancelPostButton({ post, scope }: { post: CalendarPost; scope: WorkspaceScope }) {
	const runtime = useApiRuntime();
	const queryClient = useQueryClient();
	const cancel = useMutation({
		mutationFn: () => publishingApi(runtime.transport, scope).commands.cancelPost(post.projectId, post.id),
		onSuccess: () => invalidatePublishing(queryClient, scope),
		onError: (error) =>
			toaster.create({
				type: "error",
				title: "Could not cancel the post",
				description: apiFailureMessage(error, "The post could not be canceled. Please try again."),
			}),
	});
	return (
		<Button size="sm" variant="ghost" loading={cancel.isPending} loadingText="Canceling…" onClick={() => cancel.mutate()}>
			<X size={12} />
			Cancel
		</Button>
	);
}

/** The Calendar for the selected Workspace: the view's window is one aggregate read that polls while posts are in flight. */
export function CalendarScreen() {
	const scope = useWorkspaceScope();
	if (!scope) return <CalendarLoading />;
	return <CalendarContent key={scope.workspaceId} scope={scope} />;
}

function CalendarContent({ scope }: { scope: WorkspaceScope }) {
	const runtime = useApiRuntime();
	const search = useSearchParams();
	const params: Record<string, string | undefined> = {};
	for (const [key, value] of search.entries()) params[key] = value;
	const view: CalendarView =
		params.view === "week" || params.view === "list" ? params.view : "month";
	const window = calendarWindow(view, params.month, params.date);
	const status = STATUSES.find((value) => value === params.status);
	const platform = PLATFORMS.find((value) => value === params.platform);
	const query: CalendarWindowQuery = {
		from: window.from.toISOString(),
		to: window.to.toISOString(),
		...(status ? { status } : {}),
		...(platform ? { platform } : {}),
		...(params.account && UUID.test(params.account) ? { account: params.account } : {}),
		...(params.project && UUID.test(params.project) ? { project: params.project } : {}),
	};
	const calendar = useQuery({
		...publishingQueries.calendar(runtime, scope, query),
		placeholderData: keepPreviousData,
	});
	const bootstrap = useWorkspaceBootstrap(scope);
	const error = calendar.error ?? bootstrap.error;
	if (error) {
		return (
			<PublishingLoadError
				error={error}
				title="Calendar"
				what="The calendar"
				onRetry={() => {
					void calendar.refetch();
					void bootstrap.refetch();
				}}
			/>
		);
	}
	if (!calendar.data || !bootstrap.data) return <CalendarLoading />;
	const { posts, timezone, filters, proposalCount, canPublish } = calendar.data;
	const todayKey = dateKey(new Date(), timezone);
	// Publishing (and so scheduling) starts on Creator; below it the action offers the upgrade.
	const publishUpgrade = featureUpgradePrompt(
		bootstrap.data.workspace.pricingTier,
		"publishing.schedule",
		"Upgrade to schedule posts",
	);
	const visiblePosts = posts.filter((post) => {
		if (!post.scheduledFor) return false;
		const key = dateKey(post.scheduledFor, timezone);
		const fromKey = dateKey(window.from, "UTC");
		const toKey = dateKey(window.to, "UTC");
		return key >= fromKey && key <= toKey;
	});
	const days = calendarDays(window.from, window.to, view === "month");
	function navigationHref(offset: number, nextView = view) {
		const target = new Date(window.from);
		if (view === "week") target.setUTCDate(target.getUTCDate() + offset * 7);
		else target.setUTCMonth(target.getUTCMonth() + offset);
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(params))
			if (value) query.set(key, value);
		query.set("view", nextView);
		query.set("month", target.toISOString().slice(0, 7));
		query.set("date", target.toISOString().slice(0, 10));
		return `/calendar?${query}`;
	}

	const timeInZone = (value: string) =>
		new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(new Date(value));
	// A glance at the period: how many posts are waiting, out, or need someone.
	const summary = [
		{ label: "Scheduled", tone: "accent.solid", count: visiblePosts.filter((post) => ["draft", "preparing_video", "scheduled", "publishing", "processing", "reconciling"].includes(post.status)).length },
		{ label: "Posted", tone: "fg.subtle", count: visiblePosts.filter((post) => post.status === "posted" || post.status === "inbox_delivered").length },
		{ label: "Needs attention", tone: "danger.solid", count: visiblePosts.filter((post) => post.status === "needs_attention" || post.status === "failed").length },
	].filter((entry) => entry.count > 0);
	const scheduleAction = !canPublish ? null : publishUpgrade ? (
		<LockedButton prompt={publishUpgrade}>
			<Plus size={14} />
			Schedule post
		</LockedButton>
	) : (
		<Button asChild>
			<Link href="/calendar/new">
				<Plus size={14} />
				Schedule post
			</Link>
		</Button>
	);

	return (
		<Stack gap="6">
			<Box animation="fade-up" animationFillMode="backwards" mb="2">
				<PageHeader
					title="Calendar"
					actions={
						<>
							<Button asChild variant="subtle">
								<Link href="/calendar/queue">
									<Inbox size={14} />
									{proposalCount > 0 ? `Queue · ${proposalCount} to review` : "Queue"}
								</Link>
							</Button>
							{scheduleAction}
						</>
					}
				/>
			</Box>

			<Flex align="center" justify="space-between" gap="3" wrap="wrap">
				<Flex align="center" gap="3" wrap="wrap">
					<Flex gap="0.5" align="center" bg="bg.soft" borderRadius="control" p="0.5">
						<Button asChild variant="ghost" size="sm" aria-label="Previous period">
							<Link href={navigationHref(-1)}>
								<ChevronLeft size={16} />
							</Link>
						</Button>
						<Button asChild variant="ghost" size="sm">
							<Link href={`/calendar?view=${view}`}>Today</Link>
						</Button>
						<Button asChild variant="ghost" size="sm" aria-label="Next period">
							<Link href={navigationHref(1)}>
								<ChevronRight size={16} />
							</Link>
						</Button>
					</Flex>
					<Text textStyle="title" fontSize="20px">
						{window.label}
					</Text>
					<Flex align="center" gap="1.5" h="6" px="2.5" borderRadius="full" bg="bg.soft" fontSize="11.5px" color="fg.muted">
						<Globe size={12} aria-hidden />
						{timezone}
					</Flex>
				</Flex>
				{/* View switch: a segmented track of links, the current one raised. */}
				<Flex as="nav" aria-label="Calendar view" gap="0.5" align="center" bg="bg.soft" borderRadius="control" p="0.5">
					{(["month", "week", "list"] as const).map((option) => (
						<Button
							key={option}
							asChild
							size="sm"
							variant="ghost"
							h="8"
							bg={view === option ? { _light: "white", _dark: "whiteAlpha.200" } : "transparent"}
							color={view === option ? "fg" : "fg.muted"}
							_hover={{ bg: view === option ? { _light: "white", _dark: "whiteAlpha.200" } : "bg.softHover", color: "fg" }}
						>
							<Link href={navigationHref(0, option)} aria-current={view === option ? "page" : undefined}>
								{option === "month" ? <CalendarDays size={13} /> : option === "week" ? <Columns3 size={13} /> : <ListIcon size={13} />}
								{option.charAt(0).toUpperCase() + option.slice(1)}
							</Link>
						</Button>
					))}
				</Flex>
			</Flex>

			<Flex align="center" justify="space-between" gap="3" wrap="wrap">
				<CalendarFilters
					filters={[
						{ name: "status", label: "Post status", width: "170px", items: [{ value: "", label: "All statuses" }, ...STATUSES.map((value) => ({ value, label: SOCIAL_POST_STATUS_LABELS[value] }))] },
						{ name: "platform", label: "Platform", width: "170px", items: [{ value: "", label: "All platforms" }, ...PLATFORMS.map((value) => ({ value, label: SOCIAL_PLATFORM_LABELS[value] }))] },
						{ name: "account", label: "Social account", width: "190px", items: [{ value: "", label: "All accounts" }, ...filters.accounts.map((account) => ({ value: account.id, label: account.displayName }))] },
						{ name: "project", label: "Project", width: "220px", items: [{ value: "", label: "All projects" }, ...filters.projects.map((project) => ({ value: project.id, label: project.title }))] },
					]}
				/>
				{summary.length > 0 ? (
					<Flex gap="2" wrap="wrap">
						{summary.map((entry) => (
							<Flex key={entry.label} align="center" gap="1.5" h="7" px="2.5" borderRadius="full" bg="bg.subtle" fontSize="12px" color="fg.muted">
								<Box boxSize="1.5" borderRadius="full" bg={entry.tone} />
								<Text as="span" color="fg" fontWeight="500" fontVariantNumeric="tabular-nums">
									{entry.count}
								</Text>
								{entry.label}
							</Flex>
						))}
					</Flex>
				) : null}
			</Flex>

			{visiblePosts.length === 0 && view !== "list" ? (
				<Flex align="center" justify="space-between" gap="3" wrap="wrap" px="4" py="3" borderRadius="l2" bg="bg.subtle">
					<Flex align="center" gap="2.5" fontSize="13px" color="fg.muted">
						<CalendarDays size={15} aria-hidden />
						<Text>Nothing scheduled {view === "week" ? "this week" : `in ${window.label.split(" ")[0]}`}. Pick a clip and choose when it goes out.</Text>
					</Flex>
					{canPublish && !publishUpgrade ? (
						<Button asChild size="sm" variant="subtle">
							<Link href="/calendar/new">
								Choose a clip <ArrowRight size={13} />
							</Link>
						</Button>
					) : null}
				</Flex>
			) : null}

			{visiblePosts.length === 0 && view === "list" ? (
				<EmptyState
					icon={<CalendarDays size={20} />}
					title="No scheduled posts"
					description="Schedule a clip from a project to add it to your calendar."
					action={
						!canPublish ? undefined : publishUpgrade ? (
							<LockedButton prompt={publishUpgrade}>Schedule a post</LockedButton>
						) : (
							<Button asChild>
								<Link href="/calendar/new">Schedule a post</Link>
							</Button>
						)
					}
				/>
			) : view === "list" ? (
				<Stack gap="2">
					{visiblePosts.map((post) => {
						const feedback = describeSocialPost(post, Date.now(), timezone);
						return (
							<Flex
								key={post.id}
								align={{ base: "flex-start", md: "center" }}
								direction={{ base: "column", md: "row" }}
								gap="4"
								p="4"
								bg="bg.subtle"
								borderRadius="l3"
							>
								<Flex align="center" gap="3" flex="1" minW="0">
									<BrandTile brand={post.platform} size="sm" flexShrink={0} />
									<Stack gap="0.5" minW="0">
										<Text fontSize="14px" fontWeight="500" lineClamp={1}>
											{post.caption}
										</Text>
										<Text fontSize="12px" color="fg.subtle">
											{post.project.title} ·{" "}
											{post.socialAccount?.displayName ?? "No account selected"}
										</Text>
									</Stack>
								</Flex>
								<Stack gap="0.5" align={{ md: "flex-end" }}>
									<Flex align="center" gap="1.5" fontSize="12.5px" color="fg">
										<Box boxSize="1.5" borderRadius="full" bg={statusStripe(feedback.tone)} />
										{feedback.label}
									</Flex>
									<Text
										fontSize="12px"
										color="fg.subtle"
										fontVariantNumeric="tabular-nums"
									>
										{post.scheduledFor
											? formatInTimezone(post.scheduledFor, timezone)
											: feedback.detail}
									</Text>
								</Stack>
								{canPublish &&
								(post.status === "preparing_video" ||
									post.status === "scheduled") ? (
									<CancelPostButton post={post} scope={scope} />
								) : null}
								{post.status === "needs_attention" ? (
									<Button size="sm" variant="ghost" asChild>
										<Link href={`/projects/${post.projectId}?tab=posts`}>
											Resolve
										</Link>
									</Button>
								) : null}
								<SocialPostLinks post={post} />
							</Flex>
						);
					})}
				</Stack>
			) : (
				<Box overflowX="auto" mx="-1" px="1" pb="1">
					<Grid templateColumns="repeat(7, minmax(120px, 1fr))" minW="840px" gap="1.5">
						{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
							<Text key={label} px="3" pb="1" fontSize="12px" fontWeight="500" color="fg.subtle">
								{label}
							</Text>
						))}
						{days.map((day) => {
							const key = dateKey(day, "UTC");
							const isToday = key === todayKey;
							const isPast = key < todayKey;
							const dayPosts = visiblePosts.filter(
								(post) =>
									post.scheduledFor &&
									dateKey(post.scheduledFor, timezone) === key,
							);
							const muted =
								view === "month" &&
								day.getUTCMonth() !== window.from.getUTCMonth();
							return (
								<Stack
									key={key}
									gap="1.5"
									minH={view === "week" ? "360px" : "118px"}
									p="2"
									borderRadius="l2"
									bg={isToday ? "accent.subtle" : muted ? "transparent" : "bg.subtle"}
									opacity={muted ? 0.55 : 1}
									transition="background 120ms ease"
								>
									<Flex align="center" justify="space-between" gap="1">
										<Text
											fontSize="12.5px"
											fontWeight={isToday ? "600" : "500"}
											fontVariantNumeric="tabular-nums"
											color={isToday ? "accent.contrast" : isPast || muted ? "fg.subtle" : "fg.muted"}
											bg={isToday ? "accent.solid" : "transparent"}
											borderRadius="full"
											minW="6"
											h="6"
											px="1.5"
											display="grid"
											placeItems="center"
											aria-current={isToday ? "date" : undefined}
											title={isToday ? "Today" : undefined}
										>
											{day.getUTCDate()}
										</Text>
										{isToday ? (
											<Text fontSize="11px" fontWeight="500" color="accent.fg" pe="1">
												Today
											</Text>
										) : null}
									</Flex>
									{dayPosts.map((post) => {
										const feedback = describeSocialPost(
											post,
											Date.now(),
											timezone,
										);
										return (
											<Stack
												key={post.id}
												position="relative"
												overflow="hidden"
												gap="1"
												p="2"
												ps="3"
												bg="bg.panel"
												borderRadius="8px"
											>
												{/* Status stripe: the colour says where the post is; the label under the time says it in words. */}
												<Box position="absolute" insetY="0" left="0" w="3px" bg={statusStripe(feedback.tone)} aria-hidden />
												<Flex align="center" gap="1.5" minW="0">
													<BrandTile brand={post.platform} size="sm" boxSize="18px" borderRadius="5px" flexShrink={0} />
													<Text fontSize="11.5px" color="fg.muted" fontVariantNumeric="tabular-nums" flexShrink={0}>
														{post.scheduledFor ? timeInZone(post.scheduledFor) : ""}
													</Text>
													<Text fontSize="11px" color="fg.subtle" truncate>
														{feedback.label}
													</Text>
												</Flex>
												<Text fontSize="12px" fontWeight="500" lineClamp={2}>
													{post.caption}
												</Text>
												{post.status === "needs_attention" ? (
													<Link href={`/projects/${post.projectId}?tab=posts`}>
														<Text
															fontSize="12px"
															color="danger.fg"
															fontWeight="500"
															textDecoration="underline"
															textUnderlineOffset="3px"
														>
															Resolve safely
														</Text>
													</Link>
												) : null}
												<SocialPostLinks post={post} />
											</Stack>
										);
									})}
								</Stack>
							);
						})}
					</Grid>
				</Box>
			)}
		</Stack>
	);
}
