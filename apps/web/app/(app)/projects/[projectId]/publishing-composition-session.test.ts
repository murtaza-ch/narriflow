import { expect, test } from "bun:test";
import type {
	ClipExportSnapshot,
	ClipSnapshot,
	BulkSocialScheduleOutcome,
	BulkSocialScheduleRequest,
	SocialAccountSnapshot,
	ThumbnailSelectionInput,
} from "@narriflow/validators";
import {
	createPublishingCompositionSession,
	type PublishingCompositionFacts,
	type PublishingCompositionStorage,
} from "./publishing-composition-session";
import { publishingDraftKey } from "./publishing-draft";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const clip = { id: id(2), title: "Clip", editorRevision: 1, durationSec: 30 } as ClipSnapshot;
const account = {
	id: id(3),
	platform: "youtube_shorts",
	status: "active",
} as SocialAccountSnapshot;
const otherAccount = { ...account, id: id(4) };
const facts: PublishingCompositionFacts = {
	clips: [clip],
	accounts: [account],
	workspaceTimezone: "Asia/Karachi",
	facebookPublishingEnabled: true,
};
const scope = { actorId: id(5), workspaceId: id(6), projectId: id(7) };
const storageKey = `narriflow:publishing:${scope.actorId}:${scope.workspaceId}:${scope.projectId}`;
const draftKey = publishingDraftKey(clip.id, account.id);
const submissionFacts = {
	exports: [
		{
			id: id(40),
			clipId: clip.id,
			editorRevision: 1,
			isOlderVersion: false,
			variants: [{ id: id(41), hasAsset: true, aspectRatio: "9:16", resolution: "1080p" }],
		} as ClipExportSnapshot,
	],
	options: {},
};
function memory() {
	const records = new Map<string, string>();
	const storage: PublishingCompositionStorage = {
		getItem: (key) => records.get(key) ?? null,
		setItem: (key, value) => {
			records.set(key, value);
		},
		removeItem: (key) => {
			records.delete(key);
		},
	};
	return { storage, records };
}
let ids = 100;
function session(storage = memory().storage, actorId = scope.actorId) {
	return createPublishingCompositionSession({
		scope: { ...scope, actorId },
		storage,
		createId: () => id(ids++),
		now: () => new Date("2026-10-04T20:00:00.000Z"),
	});
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const generated = {
	id: id(20),
	platform: "youtube_shorts",
	caption: "Generated",
	hashtags: ["#video"],
	title: "Generated title",
};
const cover: ThumbnailSelectionInput = {
	assetId: id(21),
	fingerprint: "a".repeat(64),
	source: "uploaded",
	sourceTimeMs: null,
};

test("construction is inert, open restores a stable snapshot and clock in the Workspace timezone", () => {
	let reads = 0;
	let clocks = 0;
	const state = createPublishingCompositionSession({
		scope,
		storage: {
			getItem: () => {
				reads++;
				return null;
			},
			setItem: () => {},
			removeItem: () => {},
		},
		createId: () => id(99),
		now: () => {
			clocks++;
			return new Date("2026-10-04T20:00:00Z");
		},
	});
	expect(reads).toBe(0);
	expect(clocks).toBe(0);
	expect(state.getSnapshot()).toBe(state.getSnapshot());
	state.open([clip.id], facts);
	expect(reads).toBe(5);
	expect(clocks).toBe(1);
	expect(state.getSnapshot().timing.startDate).toBe("2026-10-06");
	expect(state.getSnapshot().accountIds).toEqual([account.id]);
	expect(state.getSnapshot().drafts[draftKey]?.title).toBe("Clip");
});

test("subscribers see synchronous edits, stable reads and stop after unsubscribe", () => {
	const state = session();
	state.open([clip.id], facts);
	let calls = 0;
	const unsubscribe = state.subscribe(() => {
		calls++;
	});
	const before = state.getSnapshot();
	state.updateDraft(draftKey, { caption: "Manual" });
	expect(state.getSnapshot()).not.toBe(before);
	expect(before.drafts[draftKey]?.caption).toBe("");
	expect(state.getSnapshot().drafts[draftKey]?.editVersion).toBe(1);
	expect(calls).toBe(1);
	unsubscribe();
	state.updateDraft(draftKey, { caption: "Another" });
	expect(calls).toBe(1);
});

test("drafts and account edits survive a new session; all records stay scoped to the actor", async () => {
	const { storage, records } = memory();
	const state = session(storage);
	state.open([clip.id], facts);
	await state.generate({ clipId: clip.id }, async () => ({ variants: [generated] }));
	state.updateDraft(draftKey, { caption: "Manual", thumbnail: cover });
	state.updateTiming((timing) => ({
		...timing,
		scheduleMode: "scheduled",
		startDate: "2026-12-01",
	}));
	const reopened = session(storage);
	reopened.open([clip.id], facts);
	expect(reopened.getSnapshot().drafts[draftKey]?.caption).toBe("Manual");
	expect(reopened.getSnapshot().drafts[draftKey]?.thumbnail).toEqual(cover);
	expect(reopened.getSnapshot().timing.startDate).toBe("2026-12-01");
	const otherActor = session(storage, id(50));
	otherActor.open([clip.id], facts);
	expect(otherActor.getSnapshot().drafts[draftKey]?.caption).toBe("");
	expect(records.has(`${storageKey}:copy`)).toBe(true);
	expect(records.has(`${storageKey}:generations`)).toBe(true);
});

test("a late generated description cannot replace a manual edit", async () => {
	const state = session();
	state.open([clip.id], facts);
	const response = deferred<unknown>();
	const pending = state.generate({ clipId: clip.id }, () => response.promise);
	state.updateDraft(draftKey, { caption: "Manual", title: "Manual title" });
	response.resolve({ variants: [generated] });
	await pending;
	expect(state.getSnapshot().drafts[draftKey]).toMatchObject({
		caption: "Manual",
		title: "Manual title",
		edited: true,
		generated: false,
	});
	expect(state.getSnapshot().generating).toEqual([]);
});

test("a revision keeps copy, drops its cover and fences old generation until video review", async () => {
	const state = session();
	state.open([clip.id], facts);
	state.updateDraft(draftKey, { caption: "Keep me", thumbnail: cover });
	const response = deferred<unknown>();
	const pending = state.generate({ clipId: clip.id, force: true }, () => response.promise);
	state.reconcile({ ...facts, clips: [{ ...clip, editorRevision: 2 }] });
	response.resolve({ variants: [generated] });
	await pending;
	expect(state.getSnapshot().drafts[draftKey]).toMatchObject({
		caption: "Keep me",
		revision: 2,
		reviewedRevision: 1,
		thumbnail: null,
	});
	expect(state.issues(draftKey, { exports: [], options: {} })).toContain(
		"Review this clip's updated video before submitting.",
	);
	state.updateDraft(draftKey, { reviewedRevision: 2 });
	expect(state.issues(draftKey, { exports: [], options: {} })).not.toContain(
		"Review this clip's updated video before submitting.",
	);
});

test("late generation failure is fenced after edits and revisions", async () => {
	const state = session();
	state.open([clip.id], facts);
	const response = deferred<unknown>();
	const pending = state.generate({ clipId: clip.id }, () => response.promise);
	state.updateDraft(draftKey, { caption: "Manual" });
	response.reject(new Error("Old generation failed"));
	await pending;
	expect(state.getSnapshot().copyErrors).toEqual({});
});

test("generation shares a request in flight and retries a persisted identical request identity", async () => {
	const { storage } = memory();
	const state = session(storage);
	state.open([clip.id], facts);
	const response = deferred<unknown>();
	const calls: string[] = [];
	const send = (input: { idempotencyKey: string }) => {
		calls.push(input.idempotencyKey);
		return response.promise;
	};
	const first = state.generate({ clipId: clip.id, instruction: "Shorter" }, send);
	const duplicate = state.generate({ clipId: clip.id, instruction: "Shorter" }, send);
	expect(first).toBe(duplicate);
	expect(calls).toHaveLength(1);
	response.reject(new Error("Response lost"));
	await first;
	const reopened = session(storage);
	reopened.open([clip.id], facts);
	await reopened.generate({ clipId: clip.id, instruction: "Shorter" }, async (input) => {
		calls.push(input.idempotencyKey);
		return { variants: [generated] };
	});
	expect(calls[1]).toBe(calls[0]);
	await reopened.generate(
		{ clipId: clip.id, instruction: "Different", force: true },
		async (input) => {
			calls.push(input.idempotencyKey);
			return { variants: [generated] };
		},
	);
	expect(calls[2]).not.toBe(calls[0]);
});

test("one platform's saved copy seeds a newly selected account without replacing another account's edit", async () => {
	const state = session();
	state.open([clip.id], { ...facts, accounts: [account, otherAccount] });
	state.selectAccounts([account.id]);
	await state.generate({ clipId: clip.id }, async () => ({ variants: [generated] }));
	state.updateDraft(draftKey, { caption: "Account-specific" });
	state.selectAccounts([account.id, otherAccount.id]);
	expect(state.getSnapshot().drafts[draftKey]?.caption).toBe("Account-specific");
	expect(state.getSnapshot().drafts[publishingDraftKey(clip.id, otherAccount.id)]?.caption).toBe(
		"Generated\n\n#video",
	);
});

test("typed saved copy restores before pair initialization and seeds fresh drafts", () => {
	const { storage, records } = memory();
	records.set(`${storageKey}:copy`, JSON.stringify({ [`${clip.id}:1:youtube_shorts`]: generated }));
	const state = session(storage);
	state.open([clip.id], facts);
	expect(state.getSnapshot().drafts[draftKey]).toMatchObject({
		caption: "Generated\n\n#video",
		generated: true,
		variantId: generated.id,
	});
});

test("reconciliation drops ineligible destination selection but retains editable drafts", () => {
	const state = session();
	state.open([clip.id], facts);
	state.updateDraft(draftKey, { caption: "Keep account copy" });
	state.reconcile({
		...facts,
		accounts: [{ ...account, status: "expired" }],
		workspaceTimezone: "UTC",
	});
	expect(state.getSnapshot().accountIds).toEqual([]);
	expect(state.getSnapshot().drafts[draftKey]?.caption).toBe("Keep account copy");
	expect(state.getSnapshot().timing.timeZone).toBe("UTC");
});

test("missing saved cover clears only the matching entire selection and keeps copy", async () => {
	const state = session();
	state.open([clip.id], facts);
	state.updateDraft(draftKey, { caption: "Keep copy", thumbnail: cover });
	await state.checkSavedCovers(async () => ({ assets: [] }));
	expect(state.getSnapshot().drafts[draftKey]).toMatchObject({
		caption: "Keep copy",
		thumbnail: null,
	});
	expect(state.getSnapshot().error).toContain("saved cover is no longer available");
});

test("delayed saved-cover validation cannot erase a replacement sharing its asset ID", async () => {
	const state = session();
	state.open([clip.id], facts);
	state.updateDraft(draftKey, { thumbnail: cover });
	const response = deferred<{ assets: Array<{ id: string; fingerprint: string }> }>();
	const pending = state.checkSavedCovers(() => response.promise);
	const replacement = { ...cover, fingerprint: "b".repeat(64) };
	state.updateDraft(draftKey, { thumbnail: replacement });
	response.resolve({ assets: [] });
	await pending;
	expect(state.getSnapshot().drafts[draftKey]?.thumbnail).toEqual(replacement);
	expect(state.getSnapshot().error).toBe("");
});

test("cover validation failure retains the selection for server validation", async () => {
	const state = session();
	state.open([clip.id], facts);
	state.updateDraft(draftKey, { thumbnail: cover });
	await state.checkSavedCovers(async () => {
		throw new Error("Unavailable");
	});
	expect(state.getSnapshot().drafts[draftKey]?.thumbnail).toEqual(cover);
	expect(state.getSnapshot().error).toContain("validated again when you submit");
});

test("background generation admits at most two live requests and continues after one finishes", async () => {
	const state = session();
	const moreClips = [clip, { ...clip, id: id(31) }, { ...clip, id: id(32) }];
	state.open(
		moreClips.map((item) => item.id),
		{ ...facts, clips: moreClips },
	);
	const responses = new Map<string, ReturnType<typeof deferred<unknown>>>();
	const send = (input: { clipId: string }) => {
		const response = deferred<unknown>();
		responses.set(input.clipId, response);
		return response.promise;
	};
	state.generateMissing({}, send);
	expect(responses.size).toBe(2);
	expect(state.getSnapshot().generating).toHaveLength(2);
	responses.get(clip.id)!.resolve({ variants: [generated] });
	await Promise.resolve();
	await Promise.resolve();
	state.generateMissing({}, send);
	expect(responses.size).toBe(3);
	expect(state.getSnapshot().generating).toHaveLength(2);
	for (const response of responses.values()) response.resolve({ variants: [generated] });
	await Promise.resolve();
	await Promise.resolve();
});

test("incomplete generation is a manual-copy fallback, not an automatic retry loop", async () => {
	const state = session();
	state.open([clip.id], facts);
	let calls = 0;
	await state.generate({ clipId: clip.id }, async () => {
		calls++;
		return { variants: [] };
	});
	expect(state.getSnapshot().copyErrors[draftKey]).toContain("incomplete");
	state.generateMissing({}, async () => {
		calls++;
		return { variants: [generated] };
	});
	expect(calls).toBe(1);
});

test("a generation identity must persist before requesting copy, and an explicit retry reuses it", async () => {
	const { storage } = memory();
	let fail = true;
	const state = session({
		...storage,
		setItem: (key, value) => {
			if (fail && key.endsWith(":generations")) throw new Error("Storage full");
			storage.setItem(key, value);
		},
	});
	state.open([clip.id], facts);
	let calls = 0;
	await state.generate({ clipId: clip.id }, async () => {
		calls++;
		return { variants: [generated] };
	});
	expect(calls).toBe(0);
	expect(state.getSnapshot().copyErrors[draftKey]).toContain(
		"could not save the description request",
	);
	fail = false;
	await state.generate({ clipId: clip.id }, async () => {
		calls++;
		return { variants: [generated] };
	});
	expect(calls).toBe(1);
	expect(state.getSnapshot().drafts[draftKey]?.generated).toBe(true);
});

test("pending drafts and media remain coherent through a revision and late cover validation", async () => {
	const state = session();
	state.open([clip.id], facts);
	state.updateDraft(draftKey, { caption: "Frozen description", thumbnail: cover });
	const coverResponse = deferred<{ assets: Array<{ id: string; fingerprint: string }> }>();
	const checkingCover = state.checkSavedCovers(() => coverResponse.promise);
	const before = structuredClone(state.getSnapshot().drafts[draftKey]);
	await state.submit(submissionFacts, async () => {
		throw new Error("Response lost");
	});
	const pending = structuredClone(state.getSnapshot().pending);
	state.reconcile({ ...facts, clips: [{ ...clip, editorRevision: 2 }] });
	coverResponse.resolve({ assets: [] });
	await checkingCover;
	expect(state.getSnapshot().drafts[draftKey]).toEqual(before);
	expect(state.getSnapshot().pending).toEqual(pending);
	expect(state.getSnapshot().pending?.items[0]?.expectedEditorRevision).toBe(1);
	expect(state.getSnapshot().pending?.items[0]?.thumbnail).toEqual(cover);
});

test("late generation failure cannot add a warning to a pending frozen draft", async () => {
	const state = session();
	state.open([clip.id], facts);
	state.updateDraft(draftKey, { caption: "Frozen description" });
	const generationResponse = deferred<unknown>();
	const generation = state.generate(
		{ clipId: clip.id, force: true },
		() => generationResponse.promise,
	);
	await state.submit(submissionFacts, async () => {
		throw new Error("Response lost");
	});
	generationResponse.reject(new Error("Old copy failed"));
	await generation;
	expect(state.getSnapshot().copyErrors).toEqual({});
	expect(state.getSnapshot().drafts[draftKey]?.caption).toBe("Frozen description");
});

test("a failed completed-outcome reset cannot contaminate a new intent after response loss", async () => {
	const { storage, records } = memory();
	let failRemoval = false;
	let allocations = 0;
	let networkCalls = 0;
	const guardedStorage = {
		...storage,
		removeItem(key: string) {
			if (failRemoval && key.endsWith(":outcome")) throw new Error("Storage denied");
			storage.removeItem(key);
		},
	};
	const state = createPublishingCompositionSession({
		scope,
		storage: guardedStorage,
		createId: () => {
			allocations++;
			return id(600 + allocations);
		},
		now: () => new Date("2026-10-04T20:00:00Z"),
	});
	const completed = (
		payload: BulkSocialScheduleRequest,
		socialPostId: string,
	): BulkSocialScheduleOutcome => ({
		status: "completed",
		items: payload.items.map((item) => ({
			clipId: item.clipId,
			accountId: item.accountId,
			status: "succeeded",
			socialPostId,
			errorCode: null,
			retryable: false,
		})),
		counts: { succeeded: payload.items.length, failed: 0, ineligible: 0 },
	});
	state.open([clip.id], facts);
	state.updateDraft(draftKey, { caption: "Post A" });
	await state.submit(submissionFacts, async (payload) => {
		networkCalls++;
		return completed(payload, id(900));
	});
	const acceptedA = state.getSnapshot().result;
	failRemoval = true;
	state.open([clip.id], facts);
	expect(state.getSnapshot().result).toEqual(acceptedA);
	expect(state.getSnapshot().recoveryUnavailable).toBe(true);
	state.updateDraft(draftKey, { caption: "Blocked edit" });
	await state.submit(submissionFacts, async (payload) => {
		networkCalls++;
		return completed(payload, id(950));
	});
	expect(allocations).toBe(1);
	expect(networkCalls).toBe(1);
	expect(state.getSnapshot().drafts[draftKey]?.caption).toBe("Post A");
	expect(JSON.parse(records.get(`${storageKey}:outcome`)!)).toEqual(acceptedA);
	// The same session can retry the requested reset after storage recovers.
	failRemoval = false;
	await state.submit(submissionFacts, async () => {
		networkCalls++;
		throw new Error("Response lost for Post B");
	});
	expect(state.getSnapshot().recoveryUnavailable).toBe(false);
	expect(state.getSnapshot().result).toBeNull();
	expect(records.has(`${storageKey}:outcome`)).toBe(false);
	const pendingB = structuredClone(state.getSnapshot().pending);
	expect(pendingB).not.toBeNull();
	expect(allocations).toBe(2);
	const restored = session(guardedStorage);
	restored.open([clip.id], facts);
	const resultB = await restored.submit(submissionFacts, async (payload) => {
		expect(payload).toEqual(pendingB);
		return completed(payload, id(950));
	});
	expect(resultB?.items[0]?.socialPostId).toBe(id(950));
	expect(resultB?.items).toHaveLength(1);
	expect(restored.getSnapshot().pending).toBeNull();
});
