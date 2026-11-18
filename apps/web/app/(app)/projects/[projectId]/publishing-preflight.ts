import type { SocialClipHistoryItem, SocialPlatform } from "@narriflow/validators";
import { formatDate } from "@/lib/format";
import { SOCIAL_PLATFORM_LABELS } from "@/lib/social-post-status";
import { publishingDraftKey } from "./publishing-draft";

/** The API's code for an account whose connection is dead and must be reconnected. */
export const RECONNECT_REQUIRED = "social_account_reconnect_required";

/** What went wrong reading an account's publishing options; `code` is the API error code when there is one. */
export type OptionError = { code: string | null; message: string };

export function reconnectMessage(platform: SocialPlatform) {
	return `Reconnect your ${SOCIAL_PLATFORM_LABELS[platform]} account to post.`;
}

export function pendingConnectionMessage(platform: SocialPlatform) {
	return `Checking the ${SOCIAL_PLATFORM_LABELS[platform]} connection…`;
}

/** Where a person reconnects an account, returning to this selection of clips afterwards. */
export function socialAccountsHref(projectId: string, clipIds: readonly string[]) {
	return `/settings/social-accounts?returnTo=${encodeURIComponent(`/projects/${projectId}?publishClips=${clipIds.join(",")}`)}`;
}

/** How an earlier post of a clip on an account affects posting it again, most significant first. */
export type DuplicateKind = "uncertain" | "published" | "sent" | "queued";
const PRECEDENCE: DuplicateKind[] = ["uncertain", "published", "sent", "queued"];

export type DuplicateMatch = {
	kind: DuplicateKind;
	platform: SocialPlatform;
	/** When the latest published post went out, for the "Already on" line. */
	postedAt: string | null;
};

export function duplicateKind(status: SocialClipHistoryItem["status"]): DuplicateKind {
	switch (status) {
		case "needs_attention":
			return "uncertain";
		case "posted":
			return "published";
		case "inbox_delivered":
			return "sent";
		default:
			return "queued";
	}
}

/** One match per clip and account pair (keyed like drafts); several posts collapse to the most significant. */
export function classifyHistory(items: readonly SocialClipHistoryItem[]): Map<string, DuplicateMatch> {
	const matches = new Map<string, DuplicateMatch>();
	for (const item of items) {
		const key = publishingDraftKey(item.clipId, item.accountId);
		const kind = duplicateKind(item.status);
		const current = matches.get(key);
		const rank = PRECEDENCE.indexOf(kind);
		const currentRank = current ? PRECEDENCE.indexOf(current.kind) : PRECEDENCE.length;
		if (rank < currentRank) matches.set(key, { kind, platform: item.platform, postedAt: item.postedAt });
		else if (current && rank === currentRank && kind === "published" && item.postedAt && (!current.postedAt || item.postedAt > current.postedAt))
			current.postedAt = item.postedAt;
	}
	return matches;
}

/**
 * The pairs left out of a submission: every matched pair, or with `repostAnyway`
 * only the uncertain ones, which are never posted again until checked in Posts.
 */
export function skippedPairKeys(
	pairKeys: Iterable<string>,
	matches: ReadonlyMap<string, DuplicateMatch>,
	repostAnyway: boolean,
): Set<string> {
	const skipped = new Set<string>();
	for (const key of pairKeys) {
		const match = matches.get(key);
		if (match && (!repostAnyway || match.kind === "uncertain")) skipped.add(key);
	}
	return skipped;
}

export function duplicateCopy(match: DuplicateMatch) {
	switch (match.kind) {
		case "published": {
			const date = match.postedAt ? formatDate(match.postedAt) : "";
			return `Already on ${SOCIAL_PLATFORM_LABELS[match.platform]}${date ? ` · ${date}` : ""}`;
		}
		case "sent":
			return "Already sent to the TikTok inbox";
		case "queued":
			return "Already queued for this account";
		case "uncertain":
			return "An earlier post needs checking first";
	}
}

function plural(count: number, singular: string, many: string) {
	return count === 1 ? singular : many;
}

/** One sentence for the notice above the submit button, e.g. "3 of these posts are already on YouTube Shorts and 2 are queued." */
export function duplicateSummary(matches: readonly DuplicateMatch[]) {
	const published = new Map<SocialPlatform, number>();
	let sent = 0;
	let queued = 0;
	let uncertain = 0;
	for (const match of matches) {
		if (match.kind === "published") published.set(match.platform, (published.get(match.platform) ?? 0) + 1);
		else if (match.kind === "sent") sent += 1;
		else if (match.kind === "queued") queued += 1;
		else uncertain += 1;
	}
	// Each part is a count plus what to say about those posts; the first also names what they are part of.
	const parts: Array<[count: number, singular: string, many: string]> = [
		...[...published].map(([platform, count]): [number, string, string] => [count, `is already on ${SOCIAL_PLATFORM_LABELS[platform]}`, `are already on ${SOCIAL_PLATFORM_LABELS[platform]}`]),
		...(sent ? [[sent, "was already sent to the TikTok inbox", "were already sent to the TikTok inbox"] as [number, string, string]] : []),
		...(queued ? [[queued, "is queued", "are queued"] as [number, string, string]] : []),
		...(uncertain ? [[uncertain, "needs checking first", "need checking first"] as [number, string, string]] : []),
	];
	const texts = parts.map(([count, singular, many], index) => `${count}${index === 0 ? " of these posts" : ""} ${plural(count, singular, many)}`);
	const list = texts.length > 1 ? `${texts.slice(0, -1).join(", ")} and ${texts.at(-1)}` : (texts[0] ?? "");
	return `${list}.`;
}

/**
 * Empties a record only when it holds something. Resetting state to a fresh `{}` on every run of an
 * effect that also depends on that state re-renders forever; returning the same empty object does not.
 */
export function clearedRecord<T>(record: Record<string, T>): Record<string, T> {
	return Object.keys(record).length ? {} : record;
}

/**
 * The distinct clips of the pairs that will be submitted, in the order the request lists them. The
 * server derives spread slots from exactly this list, so the schedule preview must use it too.
 */
export function submittedClipIds(pairs: ReadonlyArray<{ clip: { id: string } }>): string[] {
	return [...new Set(pairs.map((pair) => pair.clip.id))];
}

/** Queue scheduling needs posting slots on every account that still has a post in the request. */
export function queueSchedulable(accounts: ReadonlyArray<{ postingSchedule?: { slots: readonly unknown[] } | null }>): boolean {
	return accounts.length > 0 && accounts.every((account) => (account.postingSchedule?.slots.length ?? 0) > 0);
}
