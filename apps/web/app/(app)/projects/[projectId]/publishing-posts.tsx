"use client";
import { SocialPlatformMark } from "@/lib/social-platform-mark";
import { SocialPostLinks } from "@/lib/social-post-links";
import { describeCounts } from "@/lib/performance-format";
import { useState } from "react";
import Link from "next/link";
import {
	Box,
	chakra,
	Flex,
	Stack,
	Text,
	Field,
	NativeSelect,
	Collapsible,
} from "@chakra-ui/react";
import {
	RefreshCw,
	Send,
	Check,
	Clock3,
	AlertCircle,
	ChevronDown,
	Copy,
	Play,
	X,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Textarea } from "@narriflow/ui/components/textarea";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { Spinner } from "@narriflow/ui/components/spinner";
import type {
	SocialPlatform,
	SocialPostSnapshot,
	ClipSnapshot,
} from "@narriflow/validators";
import {
	describeSocialPost,
	SOCIAL_PLATFORM_LABELS,
} from "@/lib/social-post-status";
import { publishingRequest } from "./publishing-draft";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { FeatureHero } from "../../_components/feature-hero";
const FILTERS = [
	["all", "All posts"],
	["scheduled", "Scheduled"],
	["posted", "Published"],
	["inbox", "TikTok inbox"],
	["attention", "Needs attention"],
] as const;

/** Soft status pill colors by tone; success is the accent, as everywhere in the app. */
const TONE_PILL = {
	success: { bg: "success.muted", color: "success.fg" },
	accent: { bg: "accent.muted", color: "accent.fg" },
	danger: { bg: "danger.muted", color: "danger.fg" },
	warning: { bg: "warning.muted", color: "warning.fg" },
	neutral: { bg: "bg.soft", color: "fg.muted" },
} as const;

const HERO_PLATFORMS: Array<{ platform: SocialPlatform; top: string; right: string }> = [
	{ platform: "tiktok", top: "12%", right: "14%" },
	{ platform: "youtube_shorts", top: "33%", right: "5%" },
	{ platform: "instagram_reels", top: "54%", right: "12%" },
];

/** What Posts is for, drawn: a clip, the platforms it goes to, and where it stands. */
function PostsHeroVisual() {
	return (
		<Box position="absolute" inset="0">
			<Flex
				position="absolute"
				left="22%"
				top="50%"
				mt="-82px"
				w="92px"
				h="164px"
				direction="column"
				align="center"
				justify="space-between"
				pt="14"
				pb="4"
				borderRadius="14px"
				color="white"
				transform="rotate(-4deg)"
				style={{ backgroundImage: "linear-gradient(135deg,#8cace0,#31486f)" }}
			>
				<Play size={20} fill="currentColor" />
				<Stack gap="1" w="full" px="3.5">
					<Box h="5px" w="full" borderRadius="full" bg="whiteAlpha.800" />
					<Box h="5px" w="60%" alignSelf="center" borderRadius="full" bg="whiteAlpha.800" />
				</Stack>
			</Flex>
			{HERO_PLATFORMS.map(({ platform, top, right }) => (
				<Flex key={platform} position="absolute" top={top} right={right} align="center" gap="1.5" h="8" ps="2.5" pe="3" bg="bg.panel" borderRadius="full" fontSize="12px" fontWeight="500" color="fg">
					<SocialPlatformMark platform={platform} size="4" />
					{SOCIAL_PLATFORM_LABELS[platform]}
				</Flex>
			))}
			<Flex position="absolute" bottom="9%" left="22%" align="center" gap="1.5" h="7" px="3" bg="bg.panel" borderRadius="full" fontSize="12px" fontWeight="500" color="accent.fg">
				<Clock3 size={12} />
				Scheduled · Fri 9:00
			</Flex>
		</Box>
	);
}

export function PublishingPosts({
	projectId,
	posts,
	clips,
	refresh,
	loadOlderPosts,
	nextCursor,
	compose,
	canManage,
	filterable = false,
	timeZone,
}: {
	projectId: string;
	posts: SocialPostSnapshot[];
	clips: ClipSnapshot[];
	refresh(): Promise<void>;
	loadOlderPosts(): Promise<void>;
	nextCursor: string | null;
	compose(clipIds: string[]): void;
	/** Role and workspace status allow changing posts; otherwise only links and copy show. */
	canManage: boolean;
	filterable?: boolean;
	timeZone: string;
}) {
	const [filter, setFilter] = useState("all");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [recovery, setRecovery] = useState<{
		id: string;
		action: "recheck" | "confirm_published" | "publish_again";
	} | null>(null);
	const [reason, setReason] = useState("");
	const [evidence, setEvidence] = useState("platform_url");
	const [reference, setReference] = useState("");
	const [ack, setAck] = useState(false);
	async function act(post: SocialPostSnapshot, action: string) {
		setBusy(post.id);
		setError("");
		try {
			const base = `/api/projects/${projectId}/social-posts/${post.id}`;
			if (action === "cancel")
				await publishingRequest(base, undefined, "DELETE");
			else if (action === "refresh-inbox")
				await publishingRequest(`${base}/refresh-inbox`, {});
			else
				await publishingRequest(
					`${base}/${action === "confirm_published" ? "confirm" : action === "publish_again" ? "publish-again" : "recheck"}`,
					{
						reason,
						...(action === "publish_again"
							? { duplicateRiskAcknowledged: ack }
							: {}),
						...(action === "confirm_published"
							? {
									evidenceKind: evidence,
									...(evidence === "platform_url"
										? { externalUrl: reference }
										: evidence === "provider_reference"
											? { providerReference: reference }
											: {}),
								}
							: {}),
					},
				);
			setRecovery(null);
			await refresh();
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "The post could not be updated.",
			);
		} finally {
			setBusy(null);
		}
	}
	const matches = (p: SocialPostSnapshot, value: string) =>
		value === "all" ||
		(value === "attention"
			? ["failed", "needs_attention"].includes(p.status)
			: value === "scheduled"
				? ["scheduled", "preparing_video"].includes(p.status)
				: value === "inbox"
					? p.status === "inbox_delivered"
					: p.status === "posted");
	const visible = posts.filter((p) => matches(p, filter));
	// A project that has never posted gets the feature intro, not five zeroed tabs.
	if (filterable && posts.length === 0 && !nextCursor) {
		return canManage ? (
			<FeatureHero
				title="Publish clips and track every post"
				points={[
					"Schedule posts, or publish now.",
					"Send drafts to your TikTok inbox.",
					"Follow each post to its live link.",
				]}
				visual={<PostsHeroVisual />}
				action={
					<Button asChild size="sm">
						<Link href={`/projects/${projectId}`}>Choose a clip</Link>
					</Button>
				}
			/>
		) : (
			<EmptyState
				icon={<Send />}
				title="Nothing published yet"
				description="Posts made from this project's clips show up here, from upload to the live link."
			/>
		);
	}
	// Only categories that have posts, plus the one being viewed.
	const filters = FILTERS.map(([value, label]) => ({
		value,
		label,
		count: posts.filter((p) => matches(p, value)).length,
	})).filter(({ value, count }) => value === "all" || value === filter || count > 0);
	return (
		<Stack gap="4">
			{filterable && (
				<Flex justify="space-between" align="center" gap="3" wrap="wrap">
					{filters.length > 1 ? (
						<Flex gap="2" wrap="wrap" role="group" aria-label="Filter posts">
							{filters.map(({ value, label, count }) => {
								const active = filter === value;
								return (
									<chakra.button
										key={value}
										type="button"
										display="inline-flex"
										alignItems="center"
										gap="1.5"
										h="8"
										px="3"
										borderRadius="full"
										fontSize="13px"
										fontWeight="500"
										bg={active ? "accent.muted" : "bg.soft"}
										color={active ? "accent.fg" : "fg.muted"}
										_hover={{ bg: active ? "accent.muted" : "bg.softHover" }}
										_focusVisible={{ outline: "2px solid", outlineColor: "accent.focusRing", outlineOffset: "2px" }}
										transition="background 0.15s ease"
										aria-pressed={active}
										onClick={() => setFilter(value)}
									>
										{label}
										<Text
											as="span"
											fontSize="12px"
											fontVariantNumeric="tabular-nums"
											color={value === "attention" && count > 0 ? "danger.fg" : active ? "accent.fg" : "fg.subtle"}
										>
											{count}
										</Text>
									</chakra.button>
								);
							})}
						</Flex>
					) : (
						<Box />
					)}
					<Button
						aria-label="Refresh"
						title="Refresh"
						variant="ghost"
						size="sm"
						onClick={() => void refresh().catch((e) => setError(e.message))}
					>
						<RefreshCw size={14} />
					</Button>
				</Flex>
			)}
			{error && (
				<Text role="alert" color="danger.fg" fontSize="sm">
					{error}
				</Text>
			)}
			{!visible.length &&
				(filterable ? (
					<Text py="10" textAlign="center" fontSize="sm" color="fg.muted">
						No posts match this filter.
					</Text>
				) : (
					<EmptyState
						icon={<Send />}
						title="No posts here yet"
						description="Publish or schedule a clip to see its progress here."
					/>
				))}
			{visible.map((post) => {
				const feedback = describeSocialPost(post, Date.now(), timeZone);
				const clip = clips.find((c) => c.id === post.clipId);

				return (
					<Stack
						key={post.id}
						display="grid"
						gridTemplateColumns="minmax(0, 1fr) auto"
						gap="3"
						p="4"
						borderRadius="l3"
						bg="bg.subtle"
						>
						<Flex
							gridColumn="1 / -1"
							justify="space-between"
							align="center"
							gap="3"
							wrap="wrap"
						>
							<Flex align="center" gap="3" minW="0">
								<Flex
								boxSize="10"
								flexShrink={0}
								borderRadius="full"
								bg="bg.panel"
								align="center"
								justify="center"
								>
									<SocialPlatformMark platform={post.platform} />
								</Flex>
								<Box minW="0">
									<Text fontSize="sm" fontWeight="550" lineClamp={1}>
									{post.accountDisplayName ??
									SOCIAL_PLATFORM_LABELS[post.platform]}
									</Text>
									<Text fontSize="xs" color="fg.muted" lineClamp={1}>
									{filterable && clip
									? [
									post.accountDisplayName
									? SOCIAL_PLATFORM_LABELS[post.platform]
									: null,
									clip.title ?? clip.hookText,
									]
									.filter(Boolean)
									.join(" · ")
									: (post.accountHandle ??
									SOCIAL_PLATFORM_LABELS[post.platform])}
									</Text>
								</Box>
							</Flex>
							<Flex
							gap="1.5"
							align="center"
							px="2.5"
							py="1"
							borderRadius="full"
							bg={TONE_PILL[feedback.tone].bg}
							color={TONE_PILL[feedback.tone].color}
							>
								{feedback.isBusy ? (
									<Spinner size="xs" />
								) : feedback.tone === "success" ? (
									<Check size={12} />
								) : feedback.tone === "danger" ||
									feedback.tone === "warning" ? (
									<AlertCircle size={12} />
								) : (
									<Clock3 size={12} />
								)}
								<Text fontSize="11px" fontWeight="medium">
									{feedback.label}
								</Text>
							</Flex>
						</Flex>
						{feedback.error && (
							<Text
							gridColumn="1 / -1"
							role="status"
							fontSize="xs"
							color="danger.fg"
							bg="bg.panel"
							borderRadius="l2"
							px="3"
							py="2"
							>
							{feedback.error}
							</Text>
						)}
						{post.latestMetrics && (
							<Text gridColumn="1 / -1" fontSize="xs" color="fg.muted">
								{describeCounts(post.latestMetrics)}
								{" · "}
								as of{" "}
								{new Intl.DateTimeFormat(undefined, {
									month: "short",
									day: "numeric",
									timeZone,
								}).format(new Date(post.latestMetrics.capturedAt))}
							</Text>
						)}
						<Collapsible.Root minW="0">
							<Flex align="center" justify="space-between" gap="2">
								<Flex align="center" gap="1.5" color="fg.muted" fontSize="xs" fontVariantNumeric="tabular-nums">
								<Clock3 size={12} />
									{post.postedAt || post.nextAttemptAt || post.scheduledFor ? (
										<time
											dateTime={
												(post.postedAt ??
													post.nextAttemptAt ??
													post.scheduledFor)!
											}
										>
											{new Intl.DateTimeFormat(undefined, {
												month: "short",
												day: "numeric",
												hour: "numeric",
												minute: "2-digit",
												timeZone,
											}).format(
												new Date(
													(post.postedAt ??
														post.nextAttemptAt ??
														post.scheduledFor)!,
												),
											)}{" "}
											· {timeZone}
										</time>
									) : (
										feedback.label
									)}
								</Flex>
								<Collapsible.Trigger asChild>
									<Button
										variant="ghost"
										size="xs"
										aria-label="Post details"
										title="Post details"
									>
										<ChevronDown size={14} />
									</Button>
								</Collapsible.Trigger>
							</Flex>
							<Collapsible.Content>
								<Stack gap="2" pt="3">
									<Text fontSize="xs" color="fg.muted">
										{feedback.detail}
									</Text>
									<Text fontSize="sm" whiteSpace="pre-wrap">
										{post.caption}
									</Text>
								</Stack>
							</Collapsible.Content>
						</Collapsible.Root>
						<Flex gap="1" wrap="wrap" align="start" justify="end">
							<SocialPostLinks post={post} compact />
							{canManage && post.deliveryMode === "tiktok_inbox" &&
								["inbox_delivered", "posted"].includes(post.status) && (
									<Button
										aria-label="Check TikTok"
										title="Check TikTok"
										size="sm"
										variant="ghost"
										disabled={busy === post.id}
										onClick={() => void act(post, "refresh-inbox")}
									>
										<RefreshCw size={14} />
									</Button>
								)}
							{post.deliveryMode === "tiktok_inbox" && post.caption && (
								<Button
									aria-label="Copy description"
									title="Copy description"
									size="sm"
									variant="ghost"
									onClick={() =>
										void navigator.clipboard
											.writeText(post.caption)
											.catch(() =>
												setError("The description could not be copied."),
											)
									}
								>
									<Copy size={14} />
								</Button>
							)}
							{post.allowedActions.includes("cancel") && (
								<Button
									aria-label="Cancel schedule"
									title="Cancel schedule"
									size="sm"
									variant="ghost"
									disabled={busy === post.id}
									onClick={() => void act(post, "cancel")}
								>
									<X size={14} />
								</Button>
							)}
							{post.allowedActions.includes("schedule_again") &&
								post.clipId && (
									<Button
										size="sm"
										variant="ghost"
										onClick={() => compose([post.clipId!])}
									>
										Schedule again
									</Button>
								)}
							{(["recheck", "confirm_published", "publish_again"] as const)
								.filter((a) => post.allowedActions.includes(a))
								.map((action) => (
									<Button
										key={action}
										size="sm"
										variant="ghost"
										disabled={busy === post.id}
										onClick={() => {
											setRecovery({ id: post.id, action });
											setReason("");
											setReference("");
											setAck(false);
										}}
									>
										{action === "recheck"
											? "Recheck"
											: action === "confirm_published"
												? "Confirm published"
												: "Publish again"}
									</Button>
								))}
							{post.allowedActions.includes("reconnect_account") ? (
								<Button size="sm" variant="subtle" asChild>
									<Link href="/settings/social-accounts">
										Reconnect account
									</Link>
								</Button>
							) : canManage && post.reconnectRequired ? (
								<Text fontSize="sm" color="fg.muted">
									Ask an owner or admin to reconnect this account
								</Text>
							) : null}
						</Flex>
						{recovery?.id === post.id && (
							<Stack
							gridColumn="1 / -1"
							gap="3"
							p="4"
							bg="bg.panel"
							borderRadius="l2"
							>
							<Field.Root>
								<Field.Label>Reason</Field.Label>
									<Textarea
										value={reason}
										onChange={(e) => setReason(e.target.value)}
										maxLength={500}
									/>
								</Field.Root>
								{recovery.action === "confirm_published" && (
									<>
										<Field.Root>
											<Field.Label>Evidence</Field.Label>
											<NativeSelect.Root>
												<NativeSelect.Field
													value={evidence}
													onChange={(e) => setEvidence(e.target.value)}
												>
													<option value="platform_url">Published link</option>
													<option value="provider_reference">
														Provider reference
													</option>
													<option value="manual_unvalidated">
														Manual confirmation
													</option>
												</NativeSelect.Field>
											</NativeSelect.Root>
										</Field.Root>
										{evidence !== "manual_unvalidated" && (
											<Field.Root>
												<Field.Label>
													{evidence === "platform_url"
														? "Published link"
														: "Provider reference"}
												</Field.Label>
												<Input
													value={reference}
													onChange={(e) => setReference(e.target.value)}
												/>
											</Field.Root>
										)}
									</>
								)}
								{recovery.action === "publish_again" && (
									<Checkbox checked={ack} onCheckedChange={setAck}>
										The earlier post may already exist. I understand this may
										create a duplicate.
									</Checkbox>
								)}
								<Flex gap="2">
									<Button
										size="sm"
										disabled={
											busy !== null ||
											!reason.trim() ||
											(recovery.action === "publish_again" && !ack) ||
											(recovery.action === "confirm_published" &&
												evidence !== "manual_unvalidated" &&
												!reference.trim())
										}
										onClick={() => void act(post, recovery.action)}
									>
										{busy === post.id ? "Saving…" : "Confirm"}
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => setRecovery(null)}
									>
										Cancel
									</Button>
								</Flex>
							</Stack>
						)}
					</Stack>
				);
			})}
			{nextCursor && filter === "all" && (
				<Button variant="subtle" onClick={() => void loadOlderPosts()}>
					Load older posts
				</Button>
			)}
		</Stack>
	);
}
