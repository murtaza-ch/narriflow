import {
	bulkSocialScheduleSchema,
	bulkSocialScheduleOutcomeSchema,
	publishingGeneratedCopySchema,
	savedPublishingSchema,
	savedPublishingCopiesSchema,
	savedPublishingGenerationRequestsSchema,
	SOCIAL_PROVIDER_CAPABILITIES,
	type BulkSocialScheduleRequest,
	type BulkSocialScheduleOutcome,
	type ClipExportSnapshot,
	type ClipSnapshot,
	type GenerateAssistedCopyRequest,
	type PublishingDraft,
	type PublishingGeneratedCopy,
	type PublishingGenerationRequest,
	type PublishingPreviewRequest,
	type SocialAccountSnapshot,
} from "@narriflow/validators";
import { formatDateInputInTimeZone } from "@/lib/format";
import {
	applyGeneratedDescription,
	blankPublishingDraft,
	currentPublicationExport,
	publishingDraftKey,
	PublishingRequestError,
} from "./publishing-draft";

export type PublishingCompositionFacts = {
	clips: ClipSnapshot[];
	accounts: SocialAccountSnapshot[];
	workspaceTimezone: string;
	facebookPublishingEnabled: boolean;
};
export type PublishingOptions = {
	privacyOptions: string[];
	commentDisabled: boolean;
	duetDisabled: boolean;
	stitchDisabled: boolean;
	maximumDurationSec: number;
	inboxEnabled: boolean;
	directEnabled: boolean;
};
type Timing = Omit<PublishingPreviewRequest, "clipIds">;
export type PublishingCompositionSnapshot = {
	restored: boolean;
	recoveryUnavailable: boolean;
	clipIds: string[];
	accountIds: string[];
	drafts: Record<string, PublishingDraft>;
	timing: Timing;
	pending: BulkSocialScheduleRequest | null;
	result: BulkSocialScheduleOutcome | null;
	busy: boolean;
	generationNeeded: boolean;
	generating: string[];
	copyErrors: Record<string, string>;
	error: string;
};
export type PublishingCompositionStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};
type SubmissionFacts = {
	exports: ClipExportSnapshot[];
	options: Record<string, PublishingOptions>;
	preferredExportId?: string;
	reviewOverrideReason?: string;
	optionErrors?: Record<string, string>;
};
type GenerationIntent = {
	clipId: string;
	accountIds?: string[];
	force?: boolean;
	instruction?: string;
	lockedPhrases?: string[];
	lockedHashtags?: string[];
};

const storageWarning = "This browser could not save your draft. Keep this page open.";
const incompleteOutcome =
	"The submission result was incomplete. Check the previous submission before trying again.";
function message(error: unknown, fallback: string) {
	return error instanceof Error ? error.message : fallback;
}
function acceptedKeys(result: BulkSocialScheduleOutcome | null) {
	return new Set(
		result?.items
			.filter((item) => item.status === "succeeded")
			.map((item) => publishingDraftKey(item.clipId, item.accountId)) ?? [],
	);
}
function countsFor(items: BulkSocialScheduleOutcome["items"]) {
	return items.reduce(
		(counts, item) => {
			if (item.status === "succeeded") counts.succeeded += 1;
			else if (item.status === "failed") counts.failed += 1;
			else if (item.status === "ineligible") counts.ineligible += 1;
			return counts;
		},
		{ succeeded: 0, failed: 0, ineligible: 0 },
	);
}

/** Owns the browser Publishing Draft protocol. Network and browser APIs are adapters. */
export function createPublishingCompositionSession(dependencies: {
	scope: { actorId: string; workspaceId: string; projectId: string };
	storage: PublishingCompositionStorage;
	createId(): string;
	now(): Date;
}) {
	const { scope, storage } = dependencies;
	const key = `narriflow:publishing:${scope.actorId}:${scope.workspaceId}:${scope.projectId}`;
	const pendingKey = `${key}:submission`;
	const outcomeKey = `${key}:outcome`;
	let facts: PublishingCompositionFacts = {
		clips: [],
		accounts: [],
		workspaceTimezone: "UTC",
		facebookPublishingEnabled: false,
	};
	let copies: Record<string, PublishingGeneratedCopy> = {};
	let generationRequests: Record<string, PublishingGenerationRequest> = {};
	let snapshot: PublishingCompositionSnapshot = {
		restored: false,
		recoveryUnavailable: false,
		clipIds: [],
		accountIds: [],
		drafts: {},
		timing: {
			scheduleMode: "now",
			startDate: "",
			timeZone: "UTC",
			postingWindow: { start: "09:00", end: "17:00" },
			frequency: { unit: "hours", value: 2 },
			dstDisambiguation: null,
		},
		pending: null,
		result: null,
		busy: false,
		generationNeeded: false,
		generating: [],
		copyErrors: {},
		error: "",
	};
	const listeners = new Set<() => void>();
	let submission: Promise<BulkSocialScheduleOutcome | null> | null = null;
	const generations = new Map<string, Promise<void>>();
	const unreadRecords = new Set<string>();
	let outcomeResetBlocked = false;
	function publish(patch: Partial<PublishingCompositionSnapshot>) {
		snapshot = { ...snapshot, ...patch };
		const accepted = acceptedKeys(snapshot.result);
		snapshot = {
			...snapshot,
			generationNeeded: pairs().some((pair) => {
				const draft = snapshot.drafts[pair.key];
				return (
					draft &&
					!accepted.has(pair.key) &&
					!draft.generated &&
					!draft.edited &&
					!snapshot.copyErrors[pair.key]
				);
			}),
		};
		for (const listener of listeners) listener();
	}
	function saveDraft() {
		try {
			storage.setItem(
				key,
				JSON.stringify({
					drafts: snapshot.drafts,
					accountIds: snapshot.accountIds,
					timing: snapshot.timing,
				}),
			);
		} catch {
			publish({ error: storageWarning });
		}
	}
	function markUnread(recordKey: string, unread: boolean) {
		if (recordKey !== pendingKey && recordKey !== outcomeKey) return;
		if (unread) unreadRecords.add(recordKey);
		else unreadRecords.delete(recordKey);
		publish({ recoveryUnavailable: unreadRecords.size > 0 || outcomeResetBlocked });
	}
	function read<T>(
		recordKey: string,
		schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
	): T | null {
		try {
			const raw = storage.getItem(recordKey);
			if (raw === null) {
				markUnread(recordKey, false);
				return null;
			}
			const parsed = schema.safeParse(JSON.parse(raw));
			if (parsed.success) {
				markUnread(recordKey, false);
				return parsed.data;
			}
			markUnread(recordKey, true);
			publish({
				error:
					"A saved publishing record could not be restored. Review your draft before submitting.",
			});
		} catch (error) {
			markUnread(recordKey, true);
			publish({
				error:
					error instanceof SyntaxError
						? "A saved publishing record could not be restored. Review your draft before submitting."
						: "Browser storage is unavailable. Keep this page open to retain your draft.",
			});
		}
		return null;
	}
	function eligibleAccounts() {
		return facts.accounts.filter(
			(account) =>
				account.status === "active" &&
				(account.platform !== "facebook_reels" || facts.facebookPublishingEnabled),
		);
	}
	function pairs() {
		const selected = snapshot.clipIds.flatMap((id) => {
			const clip = facts.clips.find((item) => item.id === id);
			return clip ? [clip] : [];
		});
		const eligible = eligibleAccounts();
		const accounts = snapshot.accountIds.flatMap((id) => {
			const account = eligible.find((item) => item.id === id);
			return account ? [account] : [];
		});
		return selected.flatMap((clip) =>
			accounts.map((account) => ({ clip, account, key: publishingDraftKey(clip.id, account.id) })),
		);
	}
	function reconcileDrafts() {
		if (snapshot.pending || snapshot.busy || snapshot.recoveryUnavailable) return;
		const drafts = { ...snapshot.drafts };
		const accepted = acceptedKeys(snapshot.result);
		let changed = false;
		for (const pair of pairs()) {
			if (accepted.has(pair.key)) continue;
			const draft = drafts[pair.key];
			if (!draft) {
				const blank = blankPublishingDraft(pair.clip, pair.account.platform);
				const seed = copies[`${pair.clip.id}:${pair.clip.editorRevision}:${pair.account.platform}`];
				drafts[pair.key] = seed ? applyGeneratedDescription(blank, 0, seed) : blank;
				changed = true;
			} else if (draft.revision !== pair.clip.editorRevision) {
				drafts[pair.key] = {
					...draft,
					revision: pair.clip.editorRevision,
					thumbnail: null,
					editVersion: draft.editVersion + 1,
				};
				changed = true;
			}
		}
		if (changed) publish({ drafts });
	}
	function restore() {
		if (snapshot.restored) return;
		publish({
			timing: {
				...snapshot.timing,
				startDate: formatDateInputInTimeZone(dependencies.now(), facts.workspaceTimezone, 1),
			},
		});
		// Records are independent: a corrupt draft must not hide a valid pending request.
		const saved = read(key, savedPublishingSchema);
		const result = read(outcomeKey, bulkSocialScheduleOutcomeSchema);
		const pending = read(pendingKey, bulkSocialScheduleSchema);
		copies = read(`${key}:copy`, savedPublishingCopiesSchema) ?? {};
		generationRequests = read(`${key}:generations`, savedPublishingGenerationRequestsSchema) ?? {};
		const eligible = eligibleAccounts();
		publish({
			restored: true,
			drafts: saved?.drafts ?? {},
			accountIds: pending
				? [...new Set(pending.items.map((item) => item.accountId))]
				: eligible.length === 1
					? [eligible[0]!.id]
					: (saved?.accountIds ?? []).filter((id) => eligible.some((account) => account.id === id)),
			timing: { ...(saved?.timing ?? snapshot.timing), timeZone: facts.workspaceTimezone },
			pending,
			result,
		});
	}
	function clearCompletedOutcome() {
		if (snapshot.pending || unreadRecords.size > 0 || snapshot.result?.status !== "completed")
			return;
		try {
			storage.removeItem(outcomeKey);
		} catch {
			outcomeResetBlocked = true;
			publish({
				recoveryUnavailable: true,
				error:
					"This browser could not start a new publishing draft. Keep this page open and check the saved submission again.",
			});
			return;
		}
		outcomeResetBlocked = false;
		publish({ result: null, recoveryUnavailable: false, error: "" });
	}
	function issues(draftKey: string, input: SubmissionFacts) {
		if (acceptedKeys(snapshot.result).has(draftKey)) return [];
		const pair = pairs().find((item) => item.key === draftKey);
		const draft = snapshot.drafts[draftKey];
		if (!pair || !draft) return ["Preparing draft…"];
		const result: string[] = [];
		if (draft.reviewedRevision !== pair.clip.editorRevision)
			result.push("Review this clip's updated video before submitting.");
		if (
			!currentPublicationExport(
				pair.clip,
				pair.account.platform,
				input.exports,
				input.preferredExportId,
			)
		)
			result.push("Prepare a compatible video.");
		if (draft.deliveryMode === "direct" && !draft.caption.trim())
			result.push("Write a description.");
		if (draft.caption.trim().length > SOCIAL_PROVIDER_CAPABILITIES[pair.account.platform].textLimit)
			result.push("Description exceeds the character limit.");
		if (input.optionErrors?.[pair.account.id]) result.push(input.optionErrors[pair.account.id]!);
		if (pair.account.platform === "tiktok") {
			const options = input.options[pair.account.id];
			if (!options) result.push("Loading TikTok settings…");
			else if (draft.deliveryMode === "tiktok_inbox" && !options.inboxEnabled)
				result.push("Reconnect TikTok to allow inbox uploads.");
			else if (draft.deliveryMode === "direct") {
				if (!options.directEnabled) result.push("Reconnect TikTok to allow direct publication.");
				if (!options.privacyOptions.includes(String(draft.settings.tiktokPrivacyLevel ?? "")))
					result.push("Choose visibility.");
				if (pair.clip.durationSec > options.maximumDurationSec)
					result.push("This video exceeds the account's duration limit.");
			}
		}
		return result;
	}
	function buildSubmission(input: SubmissionFacts) {
		const accepted = acceptedKeys(snapshot.result);
		return bulkSocialScheduleSchema.parse({
			...snapshot.timing,
			idempotencyKey: dependencies.createId(),
			items: pairs()
				.filter((pair) => !accepted.has(pair.key))
				.map((pair) => {
					const problems = issues(pair.key, input);
					if (problems.length) throw new Error(problems[0]);
					const draft = snapshot.drafts[pair.key]!;
					if (draft.reviewedRevision !== pair.clip.editorRevision)
						throw new Error("Review this clip's updated video before submitting.");
					const media = currentPublicationExport(
						pair.clip,
						pair.account.platform,
						input.exports,
						input.preferredExportId,
					);
					if (!media) throw new Error("Prepare a compatible video.");
					return {
						clipId: pair.clip.id,
						accountId: pair.account.id,
						platform: pair.account.platform,
						deliveryMode: draft.deliveryMode,
						expectedEditorRevision: pair.clip.editorRevision,
						exportId: media.export.id,
						exportVariantId: media.variant.id,
						aspectRatio: media.variant.aspectRatio,
						resolution: media.variant.resolution,
						copy: {
							variantId: draft.variantId,
							caption: draft.caption.trim(),
							hashtags: [],
							title:
								draft.deliveryMode === "direct" &&
								pair.account.platform !== "tiktok" &&
								SOCIAL_PROVIDER_CAPABILITIES[pair.account.platform].titleField
									? draft.title.trim() || null
									: null,
						},
						providerSettings:
							draft.deliveryMode === "direct"
								? {
										...draft.settings,
										...(pair.account.platform === "tiktok"
											? {
													disableComment:
														input.options[pair.account.id]?.commentDisabled ||
														draft.settings.disableComment === true,
													disableDuet:
														input.options[pair.account.id]?.duetDisabled ||
														draft.settings.disableDuet === true,
													disableStitch:
														input.options[pair.account.id]?.stitchDisabled ||
														draft.settings.disableStitch === true,
												}
											: {}),
									}
								: {},
						thumbnail: draft.deliveryMode === "direct" ? draft.thumbnail : null,
					};
				}),
			reviewOverrideReason: input.reviewOverrideReason?.trim() || null,
		});
	}
	function mergeOutcome(outcome: BulkSocialScheduleOutcome): BulkSocialScheduleOutcome {
		const accepted = (snapshot.result?.items ?? []).filter((item) => item.status === "succeeded");
		const acceptedPairs = new Set(
			accepted.map((item) => publishingDraftKey(item.clipId, item.accountId)),
		);
		const items = [
			...accepted,
			...outcome.items.filter(
				(item) => !acceptedPairs.has(publishingDraftKey(item.clipId, item.accountId)),
			),
		];
		return { ...outcome, items, counts: countsFor(items) };
	}
	async function executeSubmission(
		input: SubmissionFacts,
		send: (payload: BulkSocialScheduleRequest) => Promise<unknown>,
	) {
		try {
			if (snapshot.recoveryUnavailable) {
				const recoveredOutcome = read(outcomeKey, bulkSocialScheduleOutcomeSchema);
				const recovered = read(pendingKey, bulkSocialScheduleSchema);
				if (unreadRecords.size > 0) return null;
				publish({
					pending: recovered,
					result: recoveredOutcome ?? snapshot.result,
					...(recovered
						? {
								clipIds: [...new Set(recovered.items.map((item) => item.clipId))],
								accountIds: [...new Set(recovered.items.map((item) => item.accountId))],
							}
						: {}),
				});
				if (outcomeResetBlocked) clearCompletedOutcome();
				if (snapshot.recoveryUnavailable) return null;
			}
			let payload = snapshot.pending;
			if (!payload) {
				payload = buildSubmission(input);
				// A request is never sent unless its exact identity and payload have been saved.
				try {
					storage.setItem(pendingKey, JSON.stringify(payload));
				} catch {
					throw new Error(
						"This browser could not save the submission. Keep this page open and try again.",
					);
				}
				publish({ pending: payload });
			}
			const parsed = bulkSocialScheduleOutcomeSchema.safeParse(
				await send(structuredClone(payload)),
			);
			if (!parsed.success) throw new Error(incompleteOutcome);
			const outcome = parsed.data;
			const expected = new Set(
				payload.items.map((item) => publishingDraftKey(item.clipId, item.accountId)),
			);
			if (
				outcome.items.length !== expected.size ||
				outcome.items.some(
					(item) => !expected.has(publishingDraftKey(item.clipId, item.accountId)),
				) ||
				(outcome.status !== "running" &&
					outcome.items.some((item) => item.status === "pending" || item.status === "processing"))
			)
				throw new Error(incompleteOutcome);
			const merged = mergeOutcome(outcome);
			publish({ result: merged });
			try {
				storage.setItem(outcomeKey, JSON.stringify(merged));
			} catch {
				throw new Error(
					"This browser could not save the submission result. Keep this page open and check the previous submission.",
				);
			}
			if (outcome.status === "running") {
				publish({
					error: "Your submission is still being checked. Check again to retrieve its result.",
				});
				return null;
			}
			try {
				storage.removeItem(pendingKey);
			} catch {
				throw new Error(
					"This browser could not clear the previous submission. Keep this page open and check it again.",
				);
			}
			publish({
				pending: null,
				error: outcome.items.every((item) => item.status === "succeeded")
					? ""
					: `${merged.counts.succeeded} submitted. Review the items that need attention below.`,
			});
			return merged;
		} catch (error) {
			if (
				error instanceof PublishingRequestError &&
				error.status >= 400 &&
				error.status < 500 &&
				![408, 409, 429].includes(error.status)
			) {
				try {
					storage.removeItem(pendingKey);
					publish({ pending: null });
				} catch {
					publish({
						error:
							"This browser could not clear the previous submission. Keep this page open and check it again.",
					});
					return null;
				}
			}
			publish({
				error: message(error, "Submission could not be confirmed. Check the previous submission."),
			});
			return null;
		}
	}
	async function executeGeneration(
		intent: GenerationIntent,
		send: (input: GenerateAssistedCopyRequest) => Promise<unknown>,
		requestName: string,
	) {
		const clip = facts.clips.find((item) => item.id === intent.clipId)!;
		const accepted = acceptedKeys(snapshot.result);
		const targets = pairs().filter(
			(pair) =>
				pair.clip.id === clip.id &&
				!accepted.has(pair.key) &&
				(!intent.accountIds || intent.accountIds.includes(pair.account.id)),
		);
		const versions = new Map(
			targets.map((pair) => [pair.key, snapshot.drafts[pair.key]!.editVersion]),
		);
		const platforms = [...new Set(targets.map((pair) => pair.account.platform))];
		const input = {
			clipId: clip.id,
			platforms,
			campaignNote: "",
			revisionInstruction: intent.instruction || undefined,
			lockedPhrases: intent.lockedPhrases ?? [],
			lockedHashtags: intent.lockedHashtags ?? [],
		};
		const signature = JSON.stringify({ ...input, editorRevision: clip.editorRevision });
		const previous = generationRequests[requestName];
		const idempotencyKey =
			!intent.force && previous?.signature === signature ? previous.key : dependencies.createId();
		generationRequests = {
			...generationRequests,
			[requestName]: { key: idempotencyKey, signature },
		};
		try {
			try {
				storage.setItem(`${key}:generations`, JSON.stringify(generationRequests));
			} catch {
				throw new Error(
					"This browser could not save the description request. Keep this page open and retry, or write a description.",
				);
			}
			const response = await send({ ...input, idempotencyKey });
			const variants = publishingGeneratedCopySchema
				.array()
				.parse(
					response && typeof response === "object" && "variants" in response
						? response.variants
						: null,
				);
			if (
				variants.length !== platforms.length ||
				new Set(variants.map((variant) => variant.platform)).size !== platforms.length ||
				variants.some((variant) => !platforms.includes(variant.platform))
			)
				throw new Error("The description result was incomplete. Write one or retry.");
			for (const variant of variants)
				copies = { ...copies, [`${clip.id}:${clip.editorRevision}:${variant.platform}`]: variant };
			try {
				storage.setItem(`${key}:copy`, JSON.stringify(copies));
			} catch {
				publish({ error: storageWarning });
			}
			const drafts = { ...snapshot.drafts };
			const accepted = acceptedKeys(snapshot.result);
			for (const target of targets) {
				const draft = drafts[target.key];
				const variant = variants.find((item) => item.platform === target.account.platform);
				if (
					!snapshot.pending &&
					!snapshot.busy &&
					!snapshot.recoveryUnavailable &&
					!accepted.has(target.key) &&
					draft &&
					variant &&
					draft.revision === clip.editorRevision
				)
					drafts[target.key] = applyGeneratedDescription(draft, versions.get(target.key)!, variant);
			}
			const copyErrors = { ...snapshot.copyErrors };
			for (const target of targets) delete copyErrors[target.key];
			publish({ drafts, copyErrors });
			saveDraft();
		} catch (error) {
			const accepted = acceptedKeys(snapshot.result);
			publish({
				copyErrors: {
					...snapshot.copyErrors,
					...Object.fromEntries(
						targets
							.filter(
								(target) =>
									!snapshot.pending &&
									!snapshot.busy &&
									!snapshot.recoveryUnavailable &&
									!accepted.has(target.key) &&
									snapshot.drafts[target.key]?.revision === clip.editorRevision &&
									snapshot.drafts[target.key]?.editVersion === versions.get(target.key),
							)
							.map((target) => [
								target.key,
								message(error, "Description generation failed. Write one or retry."),
							]),
					),
				},
			});
		}
	}
	function generate(
		intent: GenerationIntent,
		send: (input: GenerateAssistedCopyRequest) => Promise<unknown>,
	): Promise<void> {
		if (snapshot.pending || snapshot.busy || snapshot.recoveryUnavailable) return Promise.resolve();
		const targets = pairs().filter(
			(pair) =>
				pair.clip.id === intent.clipId &&
				(!intent.accountIds || intent.accountIds.includes(pair.account.id)) &&
				!acceptedKeys(snapshot.result).has(pair.key),
		);
		if (!targets.length) return Promise.resolve();
		const requestName = `${intent.clipId}:${targets[0]!.clip.editorRevision}:${[...new Set(targets.map((pair) => pair.account.platform))].join(",")}`;
		const existing = generations.get(requestName);
		if (existing) return existing;
		publish({ generating: [...snapshot.generating, requestName] });
		const promise = executeGeneration(intent, send, requestName).finally(() => {
			generations.delete(requestName);
			publish({ generating: snapshot.generating.filter((name) => name !== requestName) });
		});
		generations.set(requestName, promise);
		return promise;
	}
	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		issues,
		open(clipIds: string[], currentFacts: PublishingCompositionFacts) {
			facts = currentFacts;
			restore();
			clearCompletedOutcome();
			const selected = snapshot.pending
				? [...new Set(snapshot.pending.items.map((item) => item.clipId))]
				: [...new Set(clipIds)].filter((id) => facts.clips.some((clip) => clip.id === id));
			publish({
				clipIds: selected,
				timing: {
					...snapshot.timing,
					scheduleMode:
						selected.length === 1 && snapshot.timing.scheduleMode === "spread"
							? "scheduled"
							: snapshot.timing.scheduleMode,
				},
			});
			reconcileDrafts();
			saveDraft();
		},
		reconcile(currentFacts: PublishingCompositionFacts) {
			facts = currentFacts;
			if (!snapshot.restored) return;
			const eligible = eligibleAccounts();
			const accountIds = snapshot.pending
				? snapshot.accountIds
				: snapshot.accountIds.filter((id) => eligible.some((account) => account.id === id));
			if (
				accountIds.length !== snapshot.accountIds.length ||
				snapshot.timing.timeZone !== facts.workspaceTimezone
			)
				publish({ accountIds, timing: { ...snapshot.timing, timeZone: facts.workspaceTimezone } });
			reconcileDrafts();
			saveDraft();
		},
		updateDraft(draftKey: string, patch: Partial<PublishingDraft>) {
			if (snapshot.pending || snapshot.busy || snapshot.recoveryUnavailable) return;
			const draft = snapshot.drafts[draftKey];
			if (!draft || acceptedKeys(snapshot.result).has(draftKey)) return;
			publish({
				drafts: {
					...snapshot.drafts,
					[draftKey]: { ...draft, ...patch, edited: true, editVersion: draft.editVersion + 1 },
				},
				error: "",
			});
			saveDraft();
		},
		selectAccounts(accountIds: string[]) {
			if (snapshot.pending || snapshot.busy || snapshot.recoveryUnavailable) return;
			publish({
				accountIds: [...new Set(accountIds)].filter((id) =>
					eligibleAccounts().some((account) => account.id === id),
				),
			});
			reconcileDrafts();
			saveDraft();
		},
		updateTiming(update: Timing | ((timing: Timing) => Timing)) {
			if (snapshot.pending || snapshot.busy || snapshot.recoveryUnavailable) return;
			publish({
				timing: typeof update === "function" ? update(snapshot.timing) : update,
				error: "",
			});
			saveDraft();
		},
		setError(error: string) {
			publish({ error });
		},
		async checkSavedCovers(
			send: () => Promise<{ assets: Array<{ id: string; fingerprint: string }> }>,
		) {
			const selections = Object.entries(snapshot.drafts).flatMap(([draftKey, draft]) =>
				draft.thumbnail ? [{ draftKey, selection: structuredClone(draft.thumbnail) }] : [],
			);
			if (!selections.length) return;
			try {
				const { assets } = await send();
				if (snapshot.pending || snapshot.busy || snapshot.recoveryUnavailable) return;
				const drafts = { ...snapshot.drafts };
				const accepted = acceptedKeys(snapshot.result);
				let changed = false;
				for (const { draftKey, selection } of selections) {
					if (accepted.has(draftKey)) continue;
					if (
						assets.some(
							(asset) =>
								asset.id === selection.assetId && asset.fingerprint === selection.fingerprint,
						)
					)
						continue;
					if (JSON.stringify(drafts[draftKey]?.thumbnail) !== JSON.stringify(selection)) continue;
					drafts[draftKey] = { ...drafts[draftKey]!, thumbnail: null };
					changed = true;
				}
				if (changed) {
					publish({
						drafts,
						error:
							"A saved cover is no longer available. Review the default cover or choose another before submitting.",
					});
					saveDraft();
				}
			} catch {
				publish({
					error: "Saved covers could not be checked. They will be validated again when you submit.",
				});
			}
		},
		generate,
		generateMissing(
			intent: Pick<GenerationIntent, "instruction" | "lockedPhrases" | "lockedHashtags">,
			send: (input: GenerateAssistedCopyRequest) => Promise<unknown>,
		) {
			if (snapshot.pending || snapshot.busy || snapshot.recoveryUnavailable) return;
			for (const clipId of snapshot.clipIds) {
				if (snapshot.generating.length >= 2) break;
				const targets = pairs().filter(
					(pair) =>
						pair.clip.id === clipId &&
						!snapshot.drafts[pair.key]?.generated &&
						!snapshot.drafts[pair.key]?.edited &&
						!snapshot.copyErrors[pair.key],
				);
				if (targets.length)
					void generate(
						{ ...intent, clipId, accountIds: targets.map((pair) => pair.account.id) },
						send,
					);
			}
		},
		submit(
			input: SubmissionFacts,
			send: (payload: BulkSocialScheduleRequest) => Promise<unknown>,
		): Promise<BulkSocialScheduleOutcome | null> {
			if (submission) return submission;
			if (!snapshot.restored) {
				publish({ error: "Restore the publishing draft before submitting." });
				return Promise.resolve(null);
			}
			publish({ busy: true, error: "" });
			submission = executeSubmission(input, send).finally(() => {
				submission = null;
				publish({ busy: false });
				reconcileDrafts();
				saveDraft();
			});
			return submission;
		},
	};
}

export type PublishingCompositionSession = ReturnType<typeof createPublishingCompositionSession>;
