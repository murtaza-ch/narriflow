"use client";
import { SocialPlatformMark } from "@/lib/social-platform-mark";
import { SocialPostLinks } from "@/lib/social-post-links";
import { useState } from "react";
import Link from "next/link";
import {
	Box,
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
	X,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Textarea } from "@narriflow/ui/components/textarea";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { Spinner } from "@narriflow/ui/components/spinner";
import type { SocialPostSnapshot, ClipSnapshot } from "@narriflow/validators";
import {
	describeSocialPost,
	SOCIAL_PLATFORM_LABELS,
} from "@/lib/social-post-status";
import { publishingRequest } from "./publishing-draft";

export function PublishingPosts({
	projectId,
	posts,
	clips,
	refresh,
	compose,
	filterable = false,
	timeZone,
}: {
	projectId: string;
	posts: SocialPostSnapshot[];
	clips: ClipSnapshot[];
	refresh(): Promise<void>;
	compose(clipIds: string[]): void;
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
	const visible = posts.filter(
		(p) =>
			filter === "all" ||
			(filter === "attention"
				? ["failed", "needs_attention"].includes(p.status)
				: filter === "scheduled"
					? ["scheduled", "preparing_video"].includes(p.status)
					: filter === "inbox"
						? p.status === "inbox_delivered"
						: p.status === "posted"),
	);
	return (
		<Stack gap="4">
			{filterable && (
				<Flex justify="space-between" align="center" gap="3" wrap="wrap">
					<Flex gap="1" wrap="wrap">
						{[
							["all", "All posts"],
							["scheduled", "Scheduled"],
							["posted", "Published"],
							["inbox", "TikTok inbox"],
							["attention", "Needs attention"],
						].map(([value, label]) => (
							<Button
								key={value}
								variant={filter === value ? "outline" : "ghost"}
								size="sm"
								onClick={() => setFilter(value!)}
							>
								{label}
							</Button>
						))}
					</Flex>
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
			{!visible.length && (
				<Stack align="center" py="14" gap="3" bg="bg.panel" borderRadius="l2">
					<Send size={24} />
					<Text fontWeight="medium">No posts here yet</Text>
					<Text color="fg.muted" fontSize="sm">
						Publish or schedule a clip to see its progress here.
					</Text>
				</Stack>
			)}
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
						borderWidth="1px"
						borderColor="border"
						borderRadius="xl"
						bg="bg.panel"
						_hover={{ borderColor: "border.emphasized" }}
						transition="border-color 150ms"
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
									borderRadius="xl"
									bg="bg.subtle"
									align="center"
									justify="center"
								>
									<SocialPlatformMark platform={post.platform} />
								</Flex>
								<Box minW="0">
									<Text fontSize="sm" fontWeight="semibold">
										{post.accountDisplayName ??
											SOCIAL_PLATFORM_LABELS[post.platform]}
									</Text>
									<Text fontSize="xs" color="fg.muted" lineClamp={1}>
										{filterable && clip
											? (clip.title ?? clip.hookText)
											: (post.accountHandle ??
												SOCIAL_PLATFORM_LABELS[post.platform])}
									</Text>
								</Box>
							</Flex>
							<Flex
								gap="1.5"
								align="center"
								px="2"
								py="1"
								borderRadius="full"
								bg="bg.subtle"
								color={
									feedback.tone === "success"
										? "success.fg"
										: feedback.tone === "danger"
											? "danger.fg"
											: feedback.tone === "warning"
												? "warning.fg"
												: "fg.muted"
								}
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
							>
								{feedback.error}
							</Text>
						)}
						<Collapsible.Root minW="0">
							<Flex align="center" justify="space-between" gap="2">
								<Flex align="center" gap="1.5" color="fg.muted" fontSize="xs">
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
							{post.deliveryMode === "tiktok_inbox" &&
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
							{post.allowedActions.includes("reconnect_account") && (
								<Button size="sm" variant="outline" asChild>
									<Link href="/settings/social-accounts">
										Reconnect account
									</Link>
								</Button>
							)}
						</Flex>
						{recovery?.id === post.id && (
							<Stack
								gridColumn="1 / -1"
								gap="3"
								borderTopWidth="1px"
								borderColor="border"
								pt="3"
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
		</Stack>
	);
}
