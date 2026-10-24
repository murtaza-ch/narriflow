"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Field, Flex, IconButton, Input, Stack, Text } from "@chakra-ui/react";
import { ChevronDown, ChevronRight, MoreHorizontal, Pause, Plus, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import {
	STANDING_GRANT_MAX_DAILY_CAP,
	STANDING_GRANT_MAX_WEEKLY_CAP,
	standingGrantPauseMessage,
	type StandingGrantEventView,
	type StandingGrantKind,
	type StandingGrantStatus,
	type StandingGrantView,
} from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import { CloseButton, Dialog, Portal } from "@narriflow/ui/components/dialog";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { ActionMenu } from "@narriflow/ui/components/menu";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Select } from "@narriflow/ui/components/select";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Textarea } from "@narriflow/ui/components/textarea";
import { authenticatedActionResultMessage, isAuthenticatedActionFailure } from "@/lib/authenticated-request-browser";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";
import { createStandingGrantAction, pauseStandingGrantAction, renewStandingGrantAction, revokeStandingGrantAction } from "./actions";

// A fixed locale and zone keep server and client renders identical.
const formatTime = (iso: string) =>
	`${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso))} UTC`;
const formatDay = (iso: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));

const STATUS_LABELS: Record<StandingGrantStatus, string> = { active: "Active", paused: "Paused", expired: "Expired", revoked: "Revoked" };
const EXPIRY_CHOICES = [7, 14, 30, 60, 90].map((days) => ({ value: String(days), label: `${days} days` }));

export interface GrantRuleOption {
	id: string;
	name: string;
}
export interface GrantAccountOption {
	id: string;
	label: string;
	platform: keyof typeof SOCIAL_PLATFORM_LABELS;
}

const failed = (result: unknown) =>
	isAuthenticatedActionFailure(result) || (typeof result === "object" && result !== null && "ok" in result && result.ok === false);

function StatusChip({ status }: { status: StandingGrantStatus }) {
	const paused = status === "paused";
	return (
		<Text
			as="span"
			display="inline-flex"
			alignItems="center"
			h="22px"
			px="2"
			borderRadius="6px"
			fontSize="12px"
			whiteSpace="nowrap"
			bg={paused ? "warning.subtle" : "bg.soft"}
			color={paused ? "warning.fg" : status === "active" ? "fg" : "fg.muted"}
		>
			{STATUS_LABELS[status]}
		</Text>
	);
}

function destination(grant: StandingGrantView) {
	if (grant.kind === "publish") return `Posts into ${grant.accountLabel ?? "an account"}'s queue`;
	const count = grant.reviewerCount;
	return `Sends review rounds to ${count} reviewer${count === 1 ? "" : "s"}`;
}

function eventText(event: StandingGrantEventView) {
	const by = event.actorName ? ` by ${event.actorName}` : "";
	switch (event.kind) {
		case "created":
			return `Created${by}`;
		case "renewed":
			return `Renewed to revision ${event.revision}${by}`;
		case "paused":
			return event.actorName ? `Paused${by}` : (standingGrantPauseMessage(event.reason) ?? "Paused");
		case "expired":
			return "Expired";
		case "revoked":
			return `Revoked${by}`;
		default:
			return event.kind;
	}
}

const parseEmails = (text: string) => [...new Set(text.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean))];

function Usage({ label, used, cap }: { label: string; used: number; cap: number }) {
	return (
		<Text as="span" fontSize="13px" color={used >= cap ? "warning.fg" : "fg.muted"}>
			{label} {used} of {cap}
		</Text>
	);
}

function History({ grant }: { grant: StandingGrantView }) {
	const [open, setOpen] = useState(false);
	return (
		<Box>
			<Button type="button" size="xs" variant="ghost" color="fg.muted" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
				{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				History
			</Button>
			{open ? (
				<Stack gap="4" mt="2" ps="2">
					<Stack as="ul" gap="1.5" listStyleType="none" m="0" p="0">
						{grant.history.map((event) => (
							<Flex as="li" key={`${event.kind}-${event.at}-${event.revision}`} gap="3" fontSize="13px" color="fg.muted" wrap="wrap">
								<Text as="span" color="fg">
									{eventText(event)}
								</Text>
								<Text as="span">{formatTime(event.at)}</Text>
							</Flex>
						))}
					</Stack>
					<Stack gap="1.5">
						<Text fontSize="12px" color="fg.subtle">
							{grant.kind === "publish" ? "Recent posts accepted under this grant" : "Recent rounds sent under this grant"}
						</Text>
						{grant.sent.length === 0 ? (
							<Text fontSize="13px" color="fg.muted">
								Nothing yet.
							</Text>
						) : (
							grant.sent.map((item) => (
								<Flex key={`${item.kind}-${item.id}`} gap="3" fontSize="13px" color="fg.muted" wrap="wrap">
									<Link href={`/projects/${item.projectId}`}>
										<Text as="span" color="fg" textDecoration="underline" textUnderlineOffset="3px">
											{item.label}
										</Text>
									</Link>
									<Text as="span">{formatTime(item.at)}</Text>
								</Flex>
							))
						)}
					</Stack>
				</Stack>
			) : null}
		</Box>
	);
}

function GrantDialog({
	grant,
	rules,
	accounts,
	reviewAvailable,
	initialRuleId,
	onClose,
}: {
	/** Present when renewing. */
	grant: StandingGrantView | null;
	rules: GrantRuleOption[];
	accounts: GrantAccountOption[];
	reviewAvailable: boolean;
	initialRuleId: string | null;
	onClose: () => void;
}) {
	const router = useRouter();
	const [kind, setKind] = useState<StandingGrantKind>(grant?.kind ?? "publish");
	const [ruleId, setRuleId] = useState(grant?.autopilotRuleId ?? initialRuleId ?? rules[0]?.id ?? "");
	const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
	const [reviewers, setReviewers] = useState(grant?.reviewerEmails.join("\n") ?? "");
	const [dailyCap, setDailyCap] = useState(String(grant?.dailyCap ?? 3));
	const [weeklyCap, setWeeklyCap] = useState(String(grant?.weeklyCap ?? 10));
	const [days, setDays] = useState("30");
	const [error, setError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();
	const renewing = grant !== null;
	const emails = parseEmails(reviewers);
	const ready = renewing || (ruleId && (kind === "publish" ? accountId : emails.length > 0));

	function submit(event: React.FormEvent) {
		event.preventDefault();
		setError(null);
		const terms = { dailyCap: Number(dailyCap), weeklyCap: Number(weeklyCap), expiresInDays: Number(days) };
		startTransition(async () => {
			const result = grant
				? await renewStandingGrantAction({ grantId: grant.id, ...terms, ...(grant.kind === "review_send" ? { reviewerEmails: emails } : {}) })
				: await createStandingGrantAction(
						kind === "publish"
							? { kind, autopilotRuleId: ruleId, socialAccountId: accountId, ...terms }
							: { kind, autopilotRuleId: ruleId, reviewerEmails: emails, ...terms },
					);
			if (failed(result)) {
				setError(authenticatedActionResultMessage(result, renewing ? "The grant could not be renewed." : "The grant could not be created."));
				return;
			}
			onClose();
			router.refresh();
		});
	}

	return (
		<Dialog.Root open onOpenChange={(details) => !details.open && onClose()} placement="center">
			<Portal>
				<Dialog.Backdrop />
				<Dialog.Positioner>
					<Dialog.Content asChild maxW="520px">
						<form onSubmit={submit}>
							<Dialog.Header>
								<Dialog.Title>{renewing ? "Renew grant" : "New automation grant"}</Dialog.Title>
							</Dialog.Header>
							<Dialog.Body>
								<Stack gap="5">
									{renewing ? (
										<Text fontSize="13px" color="fg.muted">
											Renewing restates the terms below, starts a new revision and resumes the grant. From now on it acts for you.
										</Text>
									) : (
										<>
											<Field.Root>
												<Field.Label>Autopilot rule</Field.Label>
												<Select
													items={rules.map((rule) => ({ value: rule.id, label: rule.name }))}
													value={ruleId}
													onValueChange={setRuleId}
													ariaLabel="Autopilot rule"
													placeholder="Choose a rule"
												/>
											</Field.Root>
											<Field.Root>
												<Field.Label>What it may do</Field.Label>
												<SegmentedControl
													value={kind}
													onValueChange={(value) => setKind(value as StandingGrantKind)}
													items={[
														{ value: "publish", label: "Post to an account" },
														{ value: "review_send", label: "Send review rounds", disabled: !reviewAvailable },
													]}
												/>
												{!reviewAvailable ? <Field.HelperText>Sending review rounds needs the Business plan.</Field.HelperText> : null}
											</Field.Root>
										</>
									)}
									{kind === "publish" && !renewing ? (
										<Field.Root>
											<Field.Label>Account</Field.Label>
											<Select
												items={accounts.map((account) => ({ value: account.id, label: `${account.label}, ${SOCIAL_PLATFORM_LABELS[account.platform]}` }))}
												value={accountId}
												onValueChange={setAccountId}
												ariaLabel="Account"
												placeholder="Choose an account"
											/>
											<Field.HelperText>
												Proposed posts for this rule go into the account's next free slot. TikTok can't be chosen: it needs the creator's choices on every post.
											</Field.HelperText>
										</Field.Root>
									) : null}
									{kind === "review_send" ? (
										<Field.Root>
											<Field.Label>Reviewers</Field.Label>
											<Textarea value={reviewers} onChange={(event) => setReviewers(event.target.value)} rows={3} placeholder={"client@example.com\neditor@example.com"} />
											<Field.HelperText>Each finished generation is sent to these people as one review round. One address per line.</Field.HelperText>
										</Field.Root>
									) : null}
									<Flex gap="4" wrap="wrap">
										<Field.Root flex="1" minW="140px">
											<Field.Label>Per day</Field.Label>
											<Input type="number" min={1} max={STANDING_GRANT_MAX_DAILY_CAP} value={dailyCap} onChange={(event) => setDailyCap(event.target.value)} />
										</Field.Root>
										<Field.Root flex="1" minW="140px">
											<Field.Label>Per week</Field.Label>
											<Input type="number" min={1} max={STANDING_GRANT_MAX_WEEKLY_CAP} value={weeklyCap} onChange={(event) => setWeeklyCap(event.target.value)} />
										</Field.Root>
									</Flex>
									<Field.Root>
										<Field.Label>Expires in</Field.Label>
										<Select items={EXPIRY_CHOICES} value={days} onValueChange={setDays} ariaLabel="Expires in" />
										<Field.HelperText>Counted over the last 24 hours and 7 days. After it expires, a person renews it.</Field.HelperText>
									</Field.Root>
									{error ? (
										<Text fontSize="13px" color="danger.fg">
											{error}
										</Text>
									) : null}
								</Stack>
							</Dialog.Body>
							<Dialog.Footer>
								<Dialog.ActionTrigger asChild>
									<Button type="button" size="sm" variant="subtle">
										Cancel
									</Button>
								</Dialog.ActionTrigger>
								<Button type="submit" size="sm" disabled={pending || !ready}>
									{pending ? <Spinner size="xs" /> : null}
									{renewing ? "Renew grant" : "Create grant"}
								</Button>
							</Dialog.Footer>
							<Dialog.CloseTrigger asChild>
								<CloseButton size="sm" />
							</Dialog.CloseTrigger>
						</form>
					</Dialog.Content>
				</Dialog.Positioner>
			</Portal>
		</Dialog.Root>
	);
}

export function GrantsPanel({
	grants,
	rules,
	accounts,
	canManage,
	reviewAvailable,
	initialRuleId,
}: {
	grants: StandingGrantView[];
	rules: GrantRuleOption[];
	accounts: GrantAccountOption[];
	canManage: boolean;
	reviewAvailable: boolean;
	initialRuleId: string | null;
}) {
	const router = useRouter();
	const { confirm, dialog } = useConfirm();
	const [editing, setEditing] = useState<{ grant: StandingGrantView | null } | null>(initialRuleId && canManage ? { grant: null } : null);
	const [message, setMessage] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	function run(task: () => Promise<unknown>, fallback: string) {
		setMessage(null);
		startTransition(async () => {
			const result = await task();
			if (failed(result)) setMessage(authenticatedActionResultMessage(result, fallback));
			router.refresh();
		});
	}

	async function revoke(grant: StandingGrantView) {
		const confirmed = await confirm({
			title: `Revoke the grant for ${grant.ruleName}?`,
			description: "Nothing more goes out under it. Posts already accepted stay scheduled. You can create a new grant later.",
			confirmLabel: "Revoke grant",
			destructive: true,
		});
		if (confirmed) run(() => revokeStandingGrantAction(grant.id), "The grant could not be revoked.");
	}

	const createButton = canManage ? (
		<Button size="sm" onClick={() => setEditing({ grant: null })} disabled={rules.length === 0}>
			<Plus size={16} />
			New grant
		</Button>
	) : null;

	return (
		<Stack gap="4">
			<Flex justify="space-between" align="center" gap="4" wrap="wrap">
				<Text fontSize="13px" color="fg.muted" maxW="640px">
					{canManage
						? "Only Owners and Admins can grant, renew, pause or revoke. A grant never overrides a Brand Profile that requires approval."
						: "Only Owners and Admins can grant, renew, pause or revoke. You can see what is granted and what went out."}
				</Text>
				{createButton}
			</Flex>

			{grants.length === 0 ? (
				<EmptyState
					icon={<ShieldCheck />}
					title="No automation grants"
					description={
						rules.length === 0
							? "Grants belong to an Autopilot rule. Create a rule first."
							: "Without a grant, every post and every review round waits for a person's click."
					}
					action={createButton ?? undefined}
				/>
			) : (
				<Stack gap="2">
					{grants.map((grant) => (
						<Stack key={grant.id} gap="3" bg="bg.subtle" borderRadius="12px" p="4">
							<Flex justify="space-between" align="flex-start" gap="3">
								<Stack gap="1" minW="0">
									<Flex align="center" gap="2.5" wrap="wrap">
										<Text fontSize="14px" fontWeight="500">
											{grant.ruleName}
										</Text>
										<StatusChip status={grant.status} />
									</Flex>
									<Text fontSize="13px" color="fg.muted">
										{destination(grant)}
									</Text>
								</Stack>
								{canManage && grant.status !== "revoked" ? (
									<ActionMenu
										ariaLabel={`${grant.ruleName} grant actions`}
										trigger={
											<IconButton size="sm" variant="ghost" color="fg.muted" aria-label={`${grant.ruleName} grant actions`} disabled={pending}>
												<MoreHorizontal size={16} />
											</IconButton>
										}
										items={[
											{ value: "renew", label: grant.status === "active" ? "Renew" : "Renew and resume", icon: <RotateCcw size={14} />, onSelect: () => setEditing({ grant }) },
											...(grant.status === "active"
												? [{ value: "pause", label: "Pause", icon: <Pause size={14} />, onSelect: () => run(() => pauseStandingGrantAction(grant.id), "The grant could not be paused.") }]
												: []),
											{ value: "revoke", label: "Revoke", icon: <Trash2 size={14} />, destructive: true, onSelect: () => void revoke(grant) },
										]}
									/>
								) : null}
							</Flex>
							{grant.optedOut.length > 0 ? (
								<Text fontSize="13px" color="fg.muted">
									Opted out of automated review requests, so skipped: {grant.optedOut.join(", ")}
								</Text>
							) : null}
							{grant.pausedMessage ? (
								<Text fontSize="13px" color="warning.fg">
									{grant.pausedMessage}
								</Text>
							) : null}
							<Flex gap={{ base: "2", md: "6" }} wrap="wrap" align="center">
								<Usage label="Last 24 hours" used={grant.usedDay} cap={grant.dailyCap} />
								<Usage label="Last 7 days" used={grant.usedWeek} cap={grant.weeklyCap} />
								<Text as="span" fontSize="13px" color="fg.muted">
									{grant.status === "expired" ? "Expired" : "Expires"} {formatDay(grant.expiresAt)}
								</Text>
								<Text as="span" fontSize="13px" color="fg.subtle">
									Revision {grant.revision}
									{grant.grantedByName ? `, for ${grant.grantedByName}` : ""}
								</Text>
							</Flex>
							<History grant={grant} />
						</Stack>
					))}
				</Stack>
			)}
			{message ? (
				<Text fontSize="13px" color="danger.fg">
					{message}
				</Text>
			) : null}
			{editing ? (
				<GrantDialog
					key={editing.grant?.id ?? "new"}
					grant={editing.grant}
					rules={rules}
					accounts={accounts}
					reviewAvailable={reviewAvailable}
					initialRuleId={initialRuleId}
					onClose={() => setEditing(null)}
				/>
			) : null}
			{dialog}
		</Stack>
	);
}
