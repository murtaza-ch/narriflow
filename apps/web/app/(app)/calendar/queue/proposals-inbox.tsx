"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Check, Inbox, X } from "lucide-react";
import type { ProposalInboxItem } from "@narriflow/services";
import type { SocialPostProposalSource } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Select } from "@narriflow/ui/components/select";
import { Switch } from "@narriflow/ui/components/switch";
import { Textarea } from "@narriflow/ui/components/textarea";
import { SocialPlatformMark } from "@/lib/social-platform-mark";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";
import { authenticatedActionResultMessage, isAuthenticatedActionFailure } from "@/lib/authenticated-request-browser";
import {
	acceptAllProposalsAction,
	acceptProposalAction,
	rejectProposalAction,
	tiktokAcceptanceOptionsAction,
	updateProposalCaptionAction,
} from "./actions";

const SOURCE_LABELS: Record<SocialPostProposalSource, string> = {
	person: "Proposed by a teammate",
	integration: "Proposed through the API",
	finishing: "Proposed by Finishing",
};

const PRIVACY_LABELS: Record<string, string> = {
	PUBLIC_TO_EVERYONE: "Public",
	MUTUAL_FOLLOW_FRIENDS: "Friends",
	FOLLOWER_OF_CREATOR: "Followers",
	SELF_ONLY: "Only me",
};

type TikTokOptions = {
	directEnabled: boolean;
	inboxEnabled: boolean;
	privacyOptions: string[];
	commentDisabled: boolean;
	duetDisabled: boolean;
	stitchDisabled: boolean;
};

type Notice = { tone: "info" | "error"; text: string };

const failed = (result: unknown) =>
	isAuthenticatedActionFailure(result) || (typeof result === "object" && result !== null && "ok" in result && result.ok === false);

function slotLabel(iso: string, timeZone: string) {
	return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function TikTokAcceptance({
	proposal,
	onAccept,
	onCancel,
	pending,
}: {
	proposal: ProposalInboxItem;
	onAccept: (choices: { deliveryMode: "direct" | "tiktok_inbox"; privacyLevel?: string; disableComment: boolean; disableDuet: boolean; disableStitch: boolean; isAigc: boolean }) => void;
	onCancel: () => void;
	pending: boolean;
}) {
	const [options, setOptions] = useState<TikTokOptions | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [mode, setMode] = useState<"direct" | "tiktok_inbox">("direct");
	const [privacy, setPrivacy] = useState("");
	const [comment, setComment] = useState(false);
	const [duet, setDuet] = useState(false);
	const [stitch, setStitch] = useState(false);
	const [aigc, setAigc] = useState(false);

	// TikTok's own limits for this creator load once, when the form opens.
	useEffect(() => {
		let alive = true;
		void tiktokAcceptanceOptionsAction(proposal.socialAccountId).then((result) => {
			if (!alive) return;
			if (failed(result)) setError(authenticatedActionResultMessage(result, "TikTok settings could not be loaded."));
			else {
				const loaded = result as TikTokOptions;
				setOptions(loaded);
				setMode(loaded.directEnabled ? "direct" : "tiktok_inbox");
				setComment(loaded.commentDisabled);
				setDuet(loaded.duetDisabled);
				setStitch(loaded.stitchDisabled);
			}
		});
		return () => {
			alive = false;
		};
	}, [proposal.socialAccountId]);

	if (error) return <Text fontSize="13px" color="danger.fg" role="alert">{error}</Text>;
	if (!options) return <Text fontSize="13px" color="fg.muted">Loading TikTok settings…</Text>;
	const direct = mode === "direct";
	return (
		<Stack gap="3" bg="bg.soft" borderRadius="l2" p="3.5">
			<Text fontSize="13px" fontWeight="500">TikTok needs your choices for this post</Text>
			<Select
				ariaLabel="How to send to TikTok"
				size="sm"
				value={mode}
				onValueChange={(value) => setMode(value as "direct" | "tiktok_inbox")}
				items={[
					...(options.directEnabled ? [{ value: "direct", label: "Post directly" }] : []),
					...(options.inboxEnabled ? [{ value: "tiktok_inbox", label: "Send to my TikTok inbox to finish there" }] : []),
				]}
			/>
			{direct ? (
				<>
					<Select
						ariaLabel="Visibility"
						size="sm"
						placeholder="Choose visibility"
						value={privacy}
						onValueChange={setPrivacy}
						items={options.privacyOptions.map((value) => ({ value, label: PRIVACY_LABELS[value] ?? value }))}
					/>
					<Flex wrap="wrap" columnGap="5" rowGap="2">
						<Switch size="sm" checked={comment} disabled={options.commentDisabled} onCheckedChange={setComment}>Turn off comments</Switch>
						<Switch size="sm" checked={duet} disabled={options.duetDisabled} onCheckedChange={setDuet}>Turn off duets</Switch>
						<Switch size="sm" checked={stitch} disabled={options.stitchDisabled} onCheckedChange={setStitch}>Turn off stitches</Switch>
						<Switch size="sm" checked={aigc} onCheckedChange={setAigc}>Made with AI</Switch>
					</Flex>
				</>
			) : null}
			<Flex gap="2">
				<Button
					size="sm"
					disabled={pending || (direct && !privacy)}
					onClick={() => onAccept({ deliveryMode: mode, privacyLevel: direct ? privacy : undefined, disableComment: comment, disableDuet: duet, disableStitch: stitch, isAigc: aigc })}
				>
					Accept into queue
				</Button>
				<Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
			</Flex>
		</Stack>
	);
}

function ProposalCard({
	proposal,
	timeZone,
	canManage,
	onResult,
}: {
	proposal: ProposalInboxItem;
	timeZone: string;
	canManage: boolean;
	onResult: (notice: Notice | null) => void;
}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [caption, setCaption] = useState(proposal.caption);
	const [choosing, setChoosing] = useState(false);
	const isTikTok = proposal.platform === "tiktok";
	const blocked = proposal.accountStatus !== "active" ? "Reconnect this account to accept" : !proposal.hasPostingSchedule ? "Add posting slots to this account to accept" : null;

	function run(task: () => Promise<unknown>, fallback: string, success?: string) {
		onResult(null);
		startTransition(async () => {
			const result = await task();
			if (failed(result)) onResult({ tone: "error", text: authenticatedActionResultMessage(result, fallback) });
			else if (success) onResult({ tone: "info", text: success });
			router.refresh();
		});
	}

	return (
		<Stack gap="3" bg="bg.subtle" borderRadius="l3" p="4">
			<Flex align="center" gap="2.5" wrap="wrap">
				<SocialPlatformMark platform={proposal.platform} />
				<Text fontSize="14px" fontWeight="500">{proposal.accountDisplayName}</Text>
				{proposal.accountHandle ? <Text fontSize="13px" color="fg.subtle">{proposal.accountHandle}</Text> : null}
				<Text fontSize="12px" color="fg.subtle" ml="auto">{SOURCE_LABELS[proposal.source]}</Text>
			</Flex>
			<Text fontSize="13px" color="fg.muted">
				<Link href={`/projects/${proposal.projectId}`}>{proposal.projectTitle}</Link> · {proposal.clipTitle} · {proposal.aspectRatio}
				{proposal.durationSec ? ` · ${Math.round(proposal.durationSec)}s` : ""}
			</Text>
			<Textarea
				aria-label={`Caption for ${SOCIAL_PLATFORM_LABELS[proposal.platform]}`}
				value={caption}
				rows={3}
				readOnly={!canManage}
				onChange={(event) => setCaption(event.target.value)}
				onBlur={() => {
					if (canManage && caption !== proposal.caption) run(() => updateProposalCaptionAction(proposal.proposalId, caption), "The caption could not be saved.");
				}}
				bg="bg.soft"
				borderWidth="0"
				fontSize="13px"
			/>
			<Flex align="center" justify="space-between" gap="3" wrap="wrap">
				<Text fontSize="13px" color="fg.muted">
					{blocked ?? (isTikTok ? "TikTok asks for your choices when you accept" : proposal.nextSlot ? `Next free slot: ${slotLabel(proposal.nextSlot, timeZone)}` : "No free slot in the next year")}
				</Text>
				{canManage ? (
					<Flex gap="2">
						<Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => rejectProposalAction(proposal.proposalId), "The proposal could not be rejected.")}>
							<X size={14} />
							Reject
						</Button>
						{!choosing ? (
							<Button
								size="sm"
								disabled={pending || Boolean(blocked) || (!isTikTok && !proposal.nextSlot)}
								onClick={() => (isTikTok ? setChoosing(true) : run(() => acceptProposalAction(proposal.proposalId, {}), "The proposal could not be accepted.", "Added to the queue."))}
							>
								<Check size={14} />
								Accept
							</Button>
						) : null}
					</Flex>
				) : null}
			</Flex>
			{choosing ? (
				<TikTokAcceptance
					proposal={proposal}
					pending={pending}
					onCancel={() => setChoosing(false)}
					onAccept={(choices) => run(() => acceptProposalAction(proposal.proposalId, { tiktok: choices }), "The proposal could not be accepted.", "Added to the queue.")}
				/>
			) : null}
		</Stack>
	);
}

export function ProposalsInbox({ proposals, timeZone, canManage }: { proposals: ProposalInboxItem[]; timeZone: string; canManage: boolean }) {
	const router = useRouter();
	const [notice, setNotice] = useState<Notice | null>(null);
	const [pending, startTransition] = useTransition();
	const acceptable = proposals.filter((proposal) => proposal.platform !== "tiktok");
	const tiktokCount = proposals.length - acceptable.length;

	function acceptAll() {
		setNotice(null);
		startTransition(async () => {
			// One call takes a batch, so a long inbox never outlasts a request: keep going from where it stopped.
			let after: string | null = null;
			let accepted = 0;
			let skippedTikTok = 0;
			const problems: string[] = [];
			let stopped: string | null = null;
			for (;;) {
				const result: unknown = await acceptAllProposalsAction(after);
				if (failed(result)) {
					stopped = authenticatedActionResultMessage(result, "The proposals could not be accepted.");
					break;
				}
				const batch = result as { accepted: unknown[]; skippedTikTok: number; failed: Array<{ message: string }>; nextCursor: string | null };
				accepted += batch.accepted.length;
				skippedTikTok = batch.skippedTikTok;
				problems.push(...batch.failed.map((entry) => entry.message));
				if (!batch.nextCursor) break;
				after = batch.nextCursor;
			}
			const parts = [`Accepted ${accepted}.`];
			if (skippedTikTok > 0) parts.push(`${skippedTikTok} for TikTok ${skippedTikTok === 1 ? "was" : "were"} skipped: accept each one to make its TikTok choices.`);
			if (problems.length > 0) parts.push(`${problems.length} could not be accepted: ${[...new Set(problems)].join(" ")}`);
			if (stopped) parts.push(`Stopped early: ${stopped}`);
			setNotice({ tone: problems.length > 0 || stopped ? "error" : "info", text: parts.join(" ") });
			router.refresh();
		});
	}

	if (proposals.length === 0) {
		return (
			<EmptyState
				icon={<Inbox />}
				title="Nothing waiting to be accepted"
				description="Posts proposed by Finishing, the API, or your assistants wait here until you accept them into a slot."
			/>
		);
	}

	return (
		<Stack gap="3">
			<Flex align="center" justify="space-between" gap="3" wrap="wrap">
				<Text fontSize="13px" color="fg.muted">
					{proposals.length} waiting{tiktokCount > 0 ? `, ${tiktokCount} for TikTok` : ""}
				</Text>
				{canManage && acceptable.length > 1 ? (
					<Button size="sm" variant="subtle" disabled={pending} onClick={acceptAll}>
						Accept all{tiktokCount > 0 ? " except TikTok" : ""}
					</Button>
				) : null}
			</Flex>
			{notice ? (
				<Box bg={notice.tone === "error" ? "danger.subtle" : "bg.soft"} borderRadius="l2" px="3.5" py="2.5" role={notice.tone === "error" ? "alert" : "status"}>
					<Text fontSize="13px" color={notice.tone === "error" ? "danger.fg" : "fg.muted"}>{notice.text}</Text>
				</Box>
			) : null}
			{proposals.map((proposal) => (
				<ProposalCard key={proposal.proposalId} proposal={proposal} timeZone={timeZone} canManage={canManage} onResult={setNotice} />
			))}
		</Stack>
	);
}
