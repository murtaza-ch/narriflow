"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Box, Flex, IconButton, Stack, Text } from "@chakra-ui/react";
import { Plus, X } from "lucide-react";
import {
	PLAN_CATALOG,
	POSTING_SCHEDULE_MAX_SLOTS,
	POSTING_WEEKDAYS,
	sortedPostingSchedule,
	type PostingSchedule,
	type PostingWeekday,
	type SocialAccountSnapshot,
} from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { TimePicker } from "@narriflow/ui/components/time-picker";
import { SocialPlatformMark } from "@/lib/social-platform-mark";
import { authenticatedActionResultMessage, isAuthenticatedActionFailure } from "@/lib/authenticated-request-browser";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { LockedButton, type UpgradePrompt } from "../../_components/upgrade";
import { savePostingScheduleAction } from "./actions";

const WEEKDAY_LABELS: Record<PostingWeekday, string> = {
	mon: "Monday",
	tue: "Tuesday",
	wed: "Wednesday",
	thu: "Thursday",
	fri: "Friday",
	sat: "Saturday",
	sun: "Sunday",
};

function twelveHour(time: string) {
	const [hours = 0, minutes = "00"] = time.split(":");
	const hour = Number(hours);
	return `${hour % 12 === 0 ? 12 : hour % 12}:${minutes} ${hour < 12 ? "AM" : "PM"}`;
}

function AccountSchedule({ account, canManage, scheduleUpgrade }: { account: SocialAccountSnapshot; canManage: boolean; scheduleUpgrade: UpgradePrompt | null }) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [slots, setSlots] = useState(account.postingSchedule?.slots ?? []);
	const [adding, setAdding] = useState<PostingWeekday | null>(null);
	const [draftTime, setDraftTime] = useState("09:00");
	const [message, setMessage] = useState<string | null>(null);
	const saved = JSON.stringify(sortedPostingSchedule(account.postingSchedule ?? { slots: [] }));
	const dirty = JSON.stringify(sortedPostingSchedule({ slots })) !== saved;

	function add(weekday: PostingWeekday) {
		if (slots.some((slot) => slot.weekday === weekday && slot.time === draftTime)) return setAdding(null);
		setSlots(sortedPostingSchedule({ slots: [...slots, { weekday, time: draftTime }] }).slots);
		setAdding(null);
	}

	function save(schedule: PostingSchedule | null) {
		setMessage(null);
		startTransition(async () => {
			const result = await savePostingScheduleAction(account.id, schedule);
			if (isAuthenticatedActionFailure(result)) setMessage(authenticatedActionResultMessage(result, "The schedule could not be saved."));
			else {
				setSlots(schedule?.slots ?? []);
				setMessage(schedule ? "Schedule saved." : "Schedule cleared.");
			}
			router.refresh();
		});
	}

	return (
		<Stack gap="3.5" bg="bg.subtle" borderRadius="l3" p="4">
			<Flex align="center" gap="2.5">
				<SocialPlatformMark platform={account.platform} />
				<Text fontSize="14px" fontWeight="500">{account.displayName}</Text>
				{account.handle ? <Text fontSize="13px" color="fg.subtle">{account.handle}</Text> : null}
				{account.status !== "active" ? <Text fontSize="12px" color="warning.fg" ml="auto">Reconnect to post</Text> : null}
			</Flex>
			<Stack gap="1">
				{POSTING_WEEKDAYS.map((weekday) => {
					const times = slots.filter((slot) => slot.weekday === weekday);
					return (
						<Flex key={weekday} align="center" gap="3" minH="9" wrap="wrap">
							<Text fontSize="13px" color="fg.muted" w="24">{WEEKDAY_LABELS[weekday]}</Text>
							<Flex gap="1.5" wrap="wrap" align="center" flex="1">
								{times.map((slot) => (
									<Flex key={slot.time} align="center" gap="1" bg="bg.soft" borderRadius="l2" pl="2.5" pr="1" h="7">
										<Text fontSize="13px" fontVariantNumeric="tabular-nums">{twelveHour(slot.time)}</Text>
										{canManage ? (
											<IconButton
												aria-label={`Remove ${WEEKDAY_LABELS[weekday]} ${twelveHour(slot.time)}`}
												size="2xs"
												variant="ghost"
												color="fg.muted"
												disabled={pending}
												onClick={() => setSlots(slots.filter((entry) => entry !== slot))}
											>
												<X size={12} />
											</IconButton>
										) : null}
									</Flex>
								))}
								{times.length === 0 && adding !== weekday ? <Text fontSize="13px" color="fg.subtle">No posts</Text> : null}
								{adding === weekday ? (
									<Flex align="center" gap="2">
										<Box w="40">
											<TimePicker ariaLabel={`${WEEKDAY_LABELS[weekday]} time`} value={draftTime} onValueChange={setDraftTime} />
										</Box>
										<Button size="xs" onClick={() => add(weekday)}>Add</Button>
										<Button size="xs" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
									</Flex>
								) : null}
							</Flex>
							{canManage && adding !== weekday && slots.length < POSTING_SCHEDULE_MAX_SLOTS ? (
								<IconButton
									aria-label={`Add a ${WEEKDAY_LABELS[weekday]} slot`}
									size="xs"
									variant="ghost"
									color="fg.muted"
									disabled={pending}
									onClick={() => setAdding(weekday)}
								>
									<Plus size={14} />
								</IconButton>
							) : null}
						</Flex>
					);
				})}
			</Stack>
			{canManage ? (
				<Flex align="center" gap="2" wrap="wrap">
					{/* Clearing slots works on any plan; saving new ones offers the upgrade. */}
					{scheduleUpgrade?.tier && slots.length > 0 ? (
						<LockedButton size="sm" disabled={!dirty} prompt={scheduleUpgrade}>
							Save schedule
						</LockedButton>
					) : (
						<Button size="sm" disabled={!dirty || pending} onClick={() => save(slots.length > 0 ? { slots } : null)}>
							Save schedule
						</Button>
					)}
					{dirty ? (
						<Button size="sm" variant="ghost" disabled={pending} onClick={() => setSlots(account.postingSchedule?.slots ?? [])}>
							Discard changes
						</Button>
					) : null}
					{message ? <Text fontSize="13px" color="fg.muted" role="status">{message}</Text> : null}
				</Flex>
			) : null}
		</Stack>
	);
}

export function PostingScheduleEditor({
	accounts,
	timeZone,
	canManage,
	scheduleUpgrade = null,
}: {
	accounts: SocialAccountSnapshot[];
	timeZone: string;
	canManage: boolean;
	/** Set when the plan can't schedule: saving slots then offers the upgrade. */
	scheduleUpgrade?: UpgradePrompt | null;
}) {
	return (
		<Stack gap="3">
			<Text fontSize="13px" color="fg.muted">
				Slots are in your Workspace time zone ({timeZone}). An accepted post takes the account&apos;s next free slot.
			</Text>
			{canManage && scheduleUpgrade?.tier ? (
				<PlanLimitNotice message={`Posting slots need the ${PLAN_CATALOG[scheduleUpgrade.tier].name} plan.`} upgrade={scheduleUpgrade} />
			) : null}
			{accounts.map((account) => (
				<AccountSchedule key={`${account.id}:${JSON.stringify(account.postingSchedule)}`} account={account} canManage={canManage} scheduleUpgrade={scheduleUpgrade} />
			))}
		</Stack>
	);
}
