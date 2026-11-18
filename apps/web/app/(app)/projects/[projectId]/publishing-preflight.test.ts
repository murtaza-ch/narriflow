import { expect, test } from "bun:test";
import type { SocialClipHistoryItem } from "@narriflow/validators";
import {
	classifyHistory,
	clearedRecord,
	duplicateCopy,
	duplicateSummary,
	pendingConnectionMessage,
	queueSchedulable,
	reconnectMessage,
	skippedPairKeys,
	socialAccountsHref,
	submittedClipIds,
} from "./publishing-preflight";
import { publishingDraftKey } from "./publishing-draft";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (over: Partial<SocialClipHistoryItem>): SocialClipHistoryItem => ({
	postId: id(900),
	clipId: id(1),
	accountId: id(2),
	platform: "youtube_shorts",
	status: "posted",
	scheduledFor: null,
	postedAt: "2026-09-02T10:00:00.000Z",
	...over,
});
const key = publishingDraftKey(id(1), id(2));

test("each status lands in its kind", () => {
	const kinds = (status: SocialClipHistoryItem["status"]) => classifyHistory([item({ status })]).get(key)?.kind;
	expect(kinds("posted")).toBe("published");
	expect(kinds("inbox_delivered")).toBe("sent");
	for (const status of ["preparing_video", "scheduled", "publishing", "processing", "reconciling"] as const)
		expect(kinds(status)).toBe("queued");
	expect(kinds("needs_attention")).toBe("uncertain");
});

test("several posts of one pair keep the most significant: uncertain, published, sent, queued", () => {
	const order = [
		item({ postId: id(1), status: "scheduled", postedAt: null }),
		item({ postId: id(2), status: "inbox_delivered", postedAt: null }),
		item({ postId: id(3), status: "posted" }),
		item({ postId: id(4), status: "needs_attention", postedAt: null }),
	];
	expect(classifyHistory(order).get(key)?.kind).toBe("uncertain");
	expect(classifyHistory(order.slice(0, 3)).get(key)?.kind).toBe("published");
	expect(classifyHistory(order.slice(0, 2).reverse()).get(key)?.kind).toBe("sent");
	expect(classifyHistory(order.slice(0, 1)).get(key)?.kind).toBe("queued");
});

test("pairs are per clip and account, and the latest published date is kept", () => {
	const matches = classifyHistory([
		item({ postedAt: "2026-09-02T10:00:00.000Z" }),
		item({ postId: id(901), postedAt: "2026-09-05T10:00:00.000Z" }),
		item({ postId: id(902), accountId: id(3), status: "scheduled", postedAt: null }),
	]);
	expect(matches.size).toBe(2);
	expect(matches.get(key)?.postedAt).toBe("2026-09-05T10:00:00.000Z");
	expect(matches.get(publishingDraftKey(id(1), id(3)))?.kind).toBe("queued");
});

test("every match is skipped, and Post again anyway frees all but uncertain ones", () => {
	const other = publishingDraftKey(id(1), id(3));
	const third = publishingDraftKey(id(1), id(4));
	const matches = classifyHistory([
		item({}),
		item({ postId: id(902), accountId: id(3), status: "needs_attention", postedAt: null }),
	]);
	const keys = [key, other, third];
	expect([...skippedPairKeys(keys, matches, false)].sort()).toEqual([key, other].sort());
	expect([...skippedPairKeys(keys, matches, true)]).toEqual([other]);
});

test("copy names the platform and date, and the summary reads as one sentence", () => {
	expect(duplicateCopy({ kind: "published", platform: "youtube_shorts", postedAt: "2026-09-02T10:00:00.000Z" })).toMatch(
		/^Already on YouTube Shorts · /,
	);
	expect(duplicateCopy({ kind: "published", platform: "x", postedAt: null })).toBe("Already on X");
	expect(duplicateCopy({ kind: "sent", platform: "tiktok", postedAt: null })).toBe("Already sent to the TikTok inbox");
	expect(duplicateCopy({ kind: "queued", platform: "x", postedAt: null })).toBe("Already queued for this account");
	expect(duplicateCopy({ kind: "uncertain", platform: "x", postedAt: null })).toBe(
		"An earlier post needs checking first",
	);
	const published = { kind: "published", platform: "youtube_shorts", postedAt: null } as const;
	const queued = { kind: "queued", platform: "youtube_shorts", postedAt: null } as const;
	expect(duplicateSummary([published, published, published, queued, queued])).toBe(
		"3 of these posts are already on YouTube Shorts and 2 are queued.",
	);
	expect(duplicateSummary([queued])).toBe("1 of these posts is queued.");
});

test("connection copy and the reconnect link", () => {
	expect(reconnectMessage("youtube_shorts")).toBe("Reconnect your YouTube Shorts account to post.");
	expect(pendingConnectionMessage("tiktok")).toBe("Checking the TikTok connection…");
	expect(socialAccountsHref("p1", ["a", "b"])).toBe(
		`/settings/social-accounts?returnTo=${encodeURIComponent("/projects/p1?publishClips=a,b")}`,
	);
});

test("clearing an already empty record returns the same object, so a reset effect cannot loop", () => {
	const empty = {};
	expect(clearedRecord(empty)).toBe(empty);
	// A render-and-reset cycle settles after one step instead of producing a new object each time.
	let state: Record<string, number> = { a: 1 };
	state = clearedRecord(state);
	const settled = state;
	for (let i = 0; i < 5; i += 1) state = clearedRecord(state);
	expect(state).toBe(settled);
	expect(Object.keys(state)).toEqual([]);
});

test("the preview clips are the distinct clips of the submitted pairs, in request order", () => {
	const pairs = [id(1), id(1), id(3), id(2), id(3)].map((clip) => ({ clip: { id: clip } }));
	expect(submittedClipIds(pairs)).toEqual([id(1), id(3), id(2)]);
	expect(submittedClipIds([])).toEqual([]);
	// A clip whose every pair is skipped drops out, and the spread spaces only the rest.
	const matches = classifyHistory([item({ clipId: id(3), accountId: id(2) }), item({ clipId: id(3), accountId: id(4) })]);
	const all = [id(1), id(3), id(2)].flatMap((clip) => [id(2), id(4)].map((account) => ({ clip: { id: clip }, key: publishingDraftKey(clip, account) })));
	const skipped = skippedPairKeys(all.map((pair) => pair.key), matches, false);
	expect(submittedClipIds(all.filter((pair) => !skipped.has(pair.key)))).toEqual([id(1), id(2)]);
	const reposted = skippedPairKeys(all.map((pair) => pair.key), matches, true);
	expect(submittedClipIds(all.filter((pair) => !reposted.has(pair.key)))).toEqual([id(1), id(3), id(2)]);
});

test("queue scheduling looks only at the accounts that still post", () => {
	const withSlots = { postingSchedule: { slots: [{}] } };
	const without = { postingSchedule: { slots: [] } };
	expect(queueSchedulable([withSlots, withSlots])).toBe(true);
	expect(queueSchedulable([withSlots, without])).toBe(false);
	expect(queueSchedulable([{ postingSchedule: null }])).toBe(false);
	expect(queueSchedulable([])).toBe(false);
});
