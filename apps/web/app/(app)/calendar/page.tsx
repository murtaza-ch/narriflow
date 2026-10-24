import { SocialPostLinks } from "@/lib/social-post-links";
import Link from "next/link";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { CalendarDays, ChevronLeft, ChevronRight, Inbox, Plus, X } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Button } from "@narriflow/ui/components/button";
import { ActionSubmitButton } from "@narriflow/ui/components/action-submit-button";
import { Select } from "@narriflow/ui/components/select";
import { publishingQueue, workspaceLibraryService, workspaceService } from "@narriflow/services";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import type { SocialPlatform, SocialPostStatus } from "@prisma/client";
import {
	describeSocialPost,
	socialPollDelayMs,
	SOCIAL_POST_STATUS_LABELS,
	type SocialPostTone,
} from "@/lib/social-post-status";
import { cancelWorkspacePostAction } from "./actions";
import { CalendarLiveRefresh } from "./calendar-live-refresh";
import { AuthenticatedActionForm } from "@/app/_components/authenticated-action-form";

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

export default async function CalendarPage({
	searchParams,
}: {
	searchParams: Promise<{
		month?: string;
		date?: string;
		view?: string;
		status?: string;
		platform?: string;
		account?: string;
		project?: string;
	}>;
}) {
	const appUser = await admitWorkspacePage("content.view");
	const params = await searchParams;
	const view: CalendarView =
		params.view === "week" || params.view === "list" ? params.view : "month";
	const window = calendarWindow(view, params.month, params.date);
	const statuses: SocialPostStatus[] = [
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
	const platforms: SocialPlatform[] = [
		"tiktok",
		"youtube_shorts",
		"instagram_reels",
		"linkedin",
		"x",
	];
	const status = statuses.includes(params.status as SocialPostStatus)
		? (params.status as SocialPostStatus)
		: undefined;
	const platform = platforms.includes(params.platform as SocialPlatform)
		? (params.platform as SocialPlatform)
		: undefined;
	const [posts, workspace, filters, proposalCount] = await Promise.all([
		workspaceLibraryService.listCalendarPosts(
			appUser,
			{
				from: new Date(window.from.getTime() - 36 * 60 * 60 * 1000),
				to: new Date(window.to.getTime() + 36 * 60 * 60 * 1000),
				status,
				platform,
				accountId: params.account,
				projectId: params.project,
			},
		),
		workspaceService.getWorkspace(appUser.actorUserId, appUser.workspaceId),
		workspaceLibraryService.getCalendarFilters(
			appUser,
		),
		publishingQueue.countProposals(appUser),
	]);
	const timezone = workspace?.timezone ?? "UTC";
	const todayKey = dateKey(new Date(), timezone);
	const canPublish =
		appUser.workspace.status === "active" &&
		appUser.workspace.role !== "viewer";
	const canEdit =
		appUser.workspace.role !== "viewer" &&
		(appUser.workspace.status === "active" ||
			appUser.workspace.role === "owner");
	const visiblePosts = posts.filter((post) => {
		if (!post.scheduledFor) return false;
		const key = dateKey(post.scheduledFor, timezone);
		const fromKey = dateKey(window.from, "UTC");
		const toKey = dateKey(window.to, "UTC");
		return key >= fromKey && key <= toKey;
	});
	const days = calendarDays(window.from, window.to, view === "month");
	const liveRefreshDelay = socialPollDelayMs(posts, Date.now());
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

	return (
		<Stack gap="8">
			<CalendarLiveRefresh delayMs={liveRefreshDelay} />
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
						{canPublish ? (
							<Button asChild>
								<Link href="/calendar/new">
									<Plus size={14} />
									Schedule post
								</Link>
							</Button>
						) : null}
					</>
				}
			/>
			<Flex align="center" justify="space-between" gap="3" wrap="wrap">
				<Flex align="baseline" gap="3" wrap="wrap">
					<Text textStyle="title" fontSize="18px">
						{window.label}
					</Text>
					<Text fontSize="12px" color="fg.subtle">
						Timezone · {timezone}
					</Text>
				</Flex>
				<Flex gap="4" align="center" wrap="wrap">
					<Flex gap="1" align="center">
						<Button
							asChild
							variant="ghost"
							size="sm"
							aria-label="Previous period"
						>
							<Link href={navigationHref(-1)}>
								<ChevronLeft size={16} />
							</Link>
						</Button>
						<Button asChild variant="subtle" size="sm">
							<Link href={`/calendar?view=${view}`}>Today</Link>
						</Button>
						<Button asChild variant="ghost" size="sm" aria-label="Next period">
							<Link href={navigationHref(1)}>
								<ChevronRight size={16} />
							</Link>
						</Button>
					</Flex>
					<Flex gap="1" align="center">
						<Button
							size="sm"
							variant={view === "month" ? "subtle" : "ghost"}
							asChild
						>
							<Link href={navigationHref(0, "month")}>Month</Link>
						</Button>
						<Button
							size="sm"
							variant={view === "week" ? "subtle" : "ghost"}
							asChild
						>
							<Link href={navigationHref(0, "week")}>Week</Link>
						</Button>
						<Button
							size="sm"
							variant={view === "list" ? "subtle" : "ghost"}
							asChild
						>
							<Link href={navigationHref(0, "list")}>List</Link>
						</Button>
					</Flex>
				</Flex>
			</Flex>
			<form
				method="get"
				style={{
					display: "flex",
					gap: "0.5rem",
					flexWrap: "wrap",
					alignItems: "flex-end",
				}}
			>
				<input type="hidden" name="date" value={params.date ?? ""} />
				<input type="hidden" name="month" value={params.month ?? ""} />
				<input type="hidden" name="view" value={params.view ?? "month"} />
				<Select
					ariaLabel="Post status"
					name="status"
					defaultValue={params.status ?? ""}
					size="sm"
					w="170px"
					items={[
						{ value: "", label: "All statuses" },
						...statuses.map((value) => ({
							value,
							label: SOCIAL_POST_STATUS_LABELS[value],
						})),
					]}
				/>
				<Select
					ariaLabel="Platform"
					name="platform"
					defaultValue={params.platform ?? ""}
					size="sm"
					w="170px"
					items={[
						{ value: "", label: "All platforms" },
						...platforms.map((value) => ({
							value,
							label: value.replace("_", " "),
						})),
					]}
				/>
				<Select
					ariaLabel="Social account"
					name="account"
					defaultValue={params.account ?? ""}
					size="sm"
					w="190px"
					items={[
						{ value: "", label: "All accounts" },
						...filters.accounts.map((account) => ({
							value: account.id,
							label: account.displayName,
						})),
					]}
				/>
				<Select
					ariaLabel="Project"
					name="project"
					defaultValue={params.project ?? ""}
					size="sm"
					w="220px"
					items={[
						{ value: "", label: "All projects" },
						...filters.projects.map((project) => ({
							value: project.id,
							label: project.title,
						})),
					]}
				/>
				<Button type="submit" size="sm" variant="subtle">
					Apply filters
				</Button>
			</form>
			{visiblePosts.length === 0 && view === "list" ? (
				<EmptyState
					icon={<CalendarDays size={20} />}
					title="No scheduled posts"
					description="Schedule a clip from a project to add it to your calendar."
					action={
						canPublish ? (
							<Button asChild>
								<Link href="/calendar/new">Schedule a post</Link>
							</Button>
						) : undefined
					}
				/>
			) : view === "list" ? (
				<Stack gap="3">
					{visiblePosts.map((post) => {
						const feedback = describeSocialPost(post, Date.now(), timezone);
						return (
							<Flex
								key={post.id}
								align={{ base: "flex-start", md: "center" }}
								direction={{ base: "column", md: "row" }}
								gap="4"
								p="4"
								bg="bg.panel"
								borderRadius="l3"
								borderWidth="1px"
								borderColor="border.card"
							>
								<Stack gap="0.5" flex="1" minW="0">
									<Text fontSize="14px" fontWeight="500" lineClamp={1}>
										{post.caption}
									</Text>
									<Text fontSize="12px" color="fg.subtle">
										{post.project.title} ·{" "}
										{post.socialAccount?.displayName ?? "No account selected"}
									</Text>
								</Stack>
								<Stack gap="0" align={{ md: "flex-end" }}>
									<Text fontSize="13px" color="fg.muted">
										{post.platform.replace("_", " ")} · {feedback.label}
									</Text>
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
								{canEdit &&
								(post.status === "preparing_video" ||
									post.status === "scheduled") ? (
									<AuthenticatedActionForm
										action={cancelWorkspacePostAction.bind(
											null,
											post.projectId,
											post.id,
										)}
									>
										<ActionSubmitButton
											pendingLabel="Canceling…"
											size="sm"
											variant="ghost"
										>
											<X size={12} />
											Cancel
										</ActionSubmitButton>
									</AuthenticatedActionForm>
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
				<Box
					borderRadius="l3"
					overflowX="auto"
					borderWidth="1px"
					borderColor="border.card"
				>
					{/* The 1px gap over a hairline ground draws the grid lines between cells. */}
					<Grid
						templateColumns="repeat(7, minmax(120px, 1fr))"
						minW="840px"
						gap="1px"
						bg="border.subtle"
					>
						{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
							<Box
								key={label}
								px="3"
								py="2"
								bg="bg.panel"
								textStyle="eyebrow"
								color="fg.muted"
							>
								{label}
							</Box>
						))}
						{days.map((day) => {
							const key = dateKey(day, "UTC");
							const isToday = key === todayKey;
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
									gap="2"
									minH={view === "week" ? "360px" : "126px"}
									p="2.5"
									bg={muted ? "bg.subtle" : "bg.panel"}
								>
									<Text
										fontSize="12px"
										fontVariantNumeric="tabular-nums"
										color={
											isToday
												? "accent.contrast"
												: muted
													? "fg.subtle"
													: "fg.muted"
										}
										bg={isToday ? "accent.solid" : "transparent"}
										borderRadius="full"
										boxSize="6"
										display="grid"
										placeItems="center"
										aria-current={isToday ? "date" : undefined}
										title={isToday ? "Today" : undefined}
									>
										{day.getUTCDate()}
									</Text>
									{dayPosts.map((post) => {
										const feedback = describeSocialPost(
											post,
											Date.now(),
											timezone,
										);
										return (
											<Box
												key={post.id}
												p="2"
												borderLeftWidth="3px"
												borderColor={statusStripe(feedback.tone)}
												bg="bg.muted"
												borderRadius="l1"
											>
												<Text fontSize="12px" fontWeight="500" lineClamp={2}>
													{post.caption}
												</Text>
												<Text mt="1" fontSize="12px" color="fg.subtle">
													{post.platform.replace("_", " ")} · {feedback.label}
												</Text>
												{post.status === "needs_attention" ? (
													<Link href={`/projects/${post.projectId}?tab=posts`}>
														<Text
															mt="1"
															fontSize="12px"
															textDecoration="underline"
														>
															Resolve safely
														</Text>
													</Link>
												) : null}
												<SocialPostLinks post={post} />
											</Box>
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
