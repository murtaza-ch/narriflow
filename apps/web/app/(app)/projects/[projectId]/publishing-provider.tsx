"use client";
import { PublishingPreview } from "./publishing-preview";
import { TimePicker } from "@narriflow/ui/components/time-picker";
import { DatePicker } from "@narriflow/ui/components/date-picker";
import { Select } from "@narriflow/ui/components/select";
import { SocialPlatformMark } from "@/lib/social-platform-mark";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useEffectEvent,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
	Avatar,
	chakra,
	Box,
	CloseButton,
	Drawer,
	Field,
	Flex,
	NativeSelect,
	Portal,
	Stack,
	Text,
	Collapsible,
} from "@chakra-ui/react";
import {
	Copy,
	Settings2,
	CheckCircle2,
	ImagePlus,
	CalendarClock,
	ChevronDown,
	Film,
	Send,
	Sparkles,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Textarea } from "@narriflow/ui/components/textarea";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
	bulkSocialScheduleSchema,
	clipExportSnapshotSchema,
	socialPostSnapshotSchema,
	SOCIAL_PROVIDER_CAPABILITIES,
	type BulkSocialScheduleRequest,
	type ClipSnapshot,
	type ClipExportSnapshot,
	type SocialAccountSnapshot,
	type SocialPlatform,
	type SocialPostSnapshot,
	type PublishingPreviewRequest,
} from "@narriflow/validators";
import { formatDateInputInTimeZone, formatDuration } from "@/lib/format";
import {
	isLiveSocialPostSnapshot,
	SOCIAL_PLATFORM_LABELS,
} from "@/lib/social-post-status";
import {
	PublishingRequestError,
	applyGeneratedDescription,
	blankPublishingDraft,
	currentPublicationExport,
	publishingDraftKey,
	publishingRequest,
	savedPublishingSchema,
	type PublishingDraft,
} from "./publishing-draft";
import { PublishingPosts } from "./publishing-posts";
import { PublishingCover } from "./publishing-cover";

type Config = {
	projectId: string;
	actorId: string;
	workspaceId: string;
	workspaceTimezone: string;
	clips: ClipSnapshot[];
	accounts: SocialAccountSnapshot[];
	initialPosts: SocialPostSnapshot[];
	assistedCopyEnabled: boolean;
	customThumbnailsEnabled: boolean;
	campaignSchedulingEnabled: boolean;
	canUploadVisualAssets: boolean;
	can1080pExport: boolean;
	canOverrideReview: boolean;
	facebookPublishingEnabled: boolean;
	canPublish: boolean;
};
type PublishingContextValue = {
	posts: SocialPostSnapshot[];
	compose(ids: string[], exportId?: string): void;
	viewPosts(ids: string[]): void;
	refresh(): Promise<void>;
	config: Config;
};
const PublishingContext = createContext<PublishingContextValue | null>(null);
export function usePublishing() {
	const context = useContext(PublishingContext);
	if (!context) throw new Error("Publishing requires its project provider");
	return context;
}
export function ProjectPosts() {
	const c = usePublishing();
	return (
		<PublishingPosts
			projectId={c.config.projectId}
			timeZone={c.config.workspaceTimezone}
			posts={c.posts}
			clips={c.config.clips}
			refresh={c.refresh}
			compose={c.compose}
			filterable
		/>
	);
}
export function PublishingProvider({
	children,
	...config
}: Config & { children: ReactNode }) {
	const triggerRef = useRef<HTMLElement | null>(null);
	const [posts, setPosts] = useState(config.initialPosts);
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<"compose" | "posts">("compose");
	const [ids, setIds] = useState<string[]>([]);
	const [exportId, setExportId] = useState<string>();
	const [statusError, setStatusError] = useState("");
	const [submission, setSubmission] = useState<BulkResult | null>(null);
	const router = useRouter();
	const params = useSearchParams();
	useEffect(() => setPosts(config.initialPosts), [config.initialPosts]);
	const refresh = useCallback(async () => {
		const result = await publishingRequest<{ posts: unknown }>(
			`/api/projects/${config.projectId}/social-posts`,
		);
		setPosts(socialPostSnapshotSchema.array().parse(result.posts));
		setStatusError("");
	}, [config.projectId]);
	useEffect(() => {
		let alive = true;
		const tick = () => {
			if (document.visibilityState === "visible")
				void refresh().catch(() => {
					if (alive)
						setStatusError("Post status could not be refreshed. Try Refresh.");
				});
		};
		const timer = setInterval(
			tick,
			posts.some(isLiveSocialPostSnapshot) ? 5000 : 30000,
		);
		window.addEventListener("focus", tick);
		return () => {
			alive = false;
			clearInterval(timer);
			window.removeEventListener("focus", tick);
		};
	}, [posts, refresh]);
	const compose = useCallback(
		(next: string[], preferred?: string) => {
			if (!config.canPublish) return;
			triggerRef.current =
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: null;
			try {
				const raw = localStorage.getItem(
					`narriflow:publishing:${config.actorId}:${config.workspaceId}:${config.projectId}:submission`,
				);
				const saved = raw
					? bulkSocialScheduleSchema.safeParse(JSON.parse(raw))
					: null;
				if (saved?.success) next = saved.data.items.map((item) => item.clipId);
			} catch {}
			setIds(
				[...new Set(next)].filter((id) =>
					config.clips.some((c) => c.id === id),
				),
			);
			setExportId(preferred);
			setMode("compose");
			setOpen(true);
		},
		[
			config.clips,
			config.canPublish,
			config.actorId,
			config.workspaceId,
			config.projectId,
		],
	);
	function viewPosts(next: string[]) {
		triggerRef.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		setIds(next);
		setMode("posts");
		setOpen(true);
		void refresh().catch(() =>
			setStatusError("Post status could not be refreshed."),
		);
	}
	const deepLink = params.get("publishClips") ?? params.get("publishClip");
	useEffect(() => {
		if (deepLink) {
			compose(deepLink.split(","), params.get("publishExport") ?? undefined);
			const next = new URLSearchParams(params);
			next.delete("publishClip");
			next.delete("publishClips");
			next.delete("publishExport");
			router.replace(`?${next.toString()}`, { scroll: false });
		}
	}, [deepLink, compose, params, router]);
	const selected = ids.flatMap((id) => {
		const clip = config.clips.find((c) => c.id === id);
		return clip ? [clip] : [];
	});
	return (
		<PublishingContext.Provider
			value={{ posts, compose, viewPosts, refresh, config }}
		>
			{children}
			<Drawer.Root
				finalFocusEl={() => triggerRef.current}
				open={open}
				onOpenChange={(d) => setOpen(d.open)}
				placement="end"
				size="full"
			>
				<Portal>
					<Drawer.Backdrop />
					<Drawer.Positioner>
						<Drawer.Content
							maxW={
								mode === "compose"
									? {
											base: "100vw",
											md: "min(900px, 100vw)",
										}
									: { base: "100vw", md: "640px" }
							}
							h="100dvh"
							bg="bg.panel"
							display="flex"
							flexDirection="column"
						>
							<Drawer.Header
								px={{ base: "4", md: "6" }}
								py="4"
								borderBottomWidth="0"
								borderColor="border"
								flexShrink={0}
							>
								<Stack gap="1">
									<Drawer.Title
										display="flex"
										alignItems="center"
										gap="2"
										fontSize="md"
									>
										{mode === "compose" ? (
											<Send size={16} />
										) : (
											<CalendarClock size={16} />
										)}
										{mode === "compose" ? "Publish" : "Posts"}
									</Drawer.Title>
									<Text color="fg.muted" fontSize="xs">
										{selected.length === 1
											? (selected[0]?.title ?? selected[0]?.hookText)
											: `${selected.length} clips selected`}
									</Text>
								</Stack>
							</Drawer.Header>
							<Drawer.CloseTrigger asChild>
								<CloseButton size="sm" aria-label="Close publishing drawer" />
							</Drawer.CloseTrigger>
							{mode === "compose" && selected.length > 0 ? (
								<PublishingComposer
									config={config}
									clips={selected}
									preferredExportId={exportId}
									open={open}
									onSubmitted={async (outcome) => {
										setSubmission(outcome);
										setMode("posts");
										await refresh().catch(() =>
											setStatusError(
												"Posts could not be refreshed. Your submission has been saved.",
											),
										);
									}}
								/>
							) : (
								<Drawer.Body p={{ base: "4", md: "6" }} overflowY="auto">
									{submission?.items.some(
										(item) => item.status !== "succeeded",
									) && (
										<Stack
											mb="4"
											p="3"
											borderWidth="1px"
											borderColor="border"
											borderRadius="l2"
										>
											<Text fontSize="sm">
												Some items need attention. Submitted items will not be
												sent again.
											</Text>
											{submission.items
												.filter((item) => item.status !== "succeeded")
												.map((item) => (
													<Text
														key={`${item.clipId}:${item.accountId}`}
														fontSize="xs"
														color="warning.fg"
													>
														{
															config.clips.find(
																(clip) => clip.id === item.clipId,
															)?.title
														}
														: {item.errorCode?.replaceAll("_", " ")}
													</Text>
												))}
											<Button
												size="sm"
												variant="outline"
												onClick={() => compose(ids)}
											>
												Continue unfinished draft
											</Button>
										</Stack>
									)}
									{statusError && (
										<Text role="status" color="warning.fg" fontSize="sm" mb="3">
											{statusError}
										</Text>
									)}
									<PublishingPosts
										timeZone={config.workspaceTimezone}
										projectId={config.projectId}
										posts={posts.filter(
											(p) => p.clipId && ids.includes(p.clipId),
										)}
										clips={config.clips}
										refresh={refresh}
										compose={compose}
									/>
								</Drawer.Body>
							)}
						</Drawer.Content>
					</Drawer.Positioner>
				</Portal>
			</Drawer.Root>
		</PublishingContext.Provider>
	);
}

type Options = {
	privacyOptions: string[];
	commentDisabled: boolean;
	duetDisabled: boolean;
	stitchDisabled: boolean;
	maximumDurationSec: number;
	inboxEnabled: boolean;
	directEnabled: boolean;
};
type Generated = {
	id: string;
	platform: SocialPlatform;
	caption: string;
	hashtags: string[];
	title: string | null;
};
type BulkResult = {
	status: string;
	items: Array<{
		clipId: string;
		accountId: string;
		status: string;
		socialPostId: string | null;
		errorCode: string | null;
		retryable: boolean;
	}>;
	counts: { succeeded: number; failed: number; ineligible: number };
};
function PublishingComposer({
	config,
	clips,
	preferredExportId,
	open,
	onSubmitted,
}: {
	config: Config;
	clips: ClipSnapshot[];
	preferredExportId?: string;
	open: boolean;
	onSubmitted(outcome: BulkResult): Promise<void>;
}) {
	const router = useRouter();
	const storageKey = `narriflow:publishing:${config.actorId}:${config.workspaceId}:${config.projectId}`;
	const pendingKey = `${storageKey}:submission`;
	const outcomeKey = `${storageKey}:outcome`;
	const [restored, setRestored] = useState(false);
	const [drafts, setDrafts] = useState<Record<string, PublishingDraft>>({});
	const draftRef = useRef(drafts);
	draftRef.current = drafts;
	const [accountIds, setAccountIds] = useState<string[]>([]);
	const [activeId, setActiveId] = useState(clips[0]!.id);
	const [exports, setExports] = useState<ClipExportSnapshot[]>([]);
	const [options, setOptions] = useState<Record<string, Options>>({});
	const [optionErrors, setOptionErrors] = useState<Record<string, string>>({});
	const [timing, setTiming] = useState<
		Omit<PublishingPreviewRequest, "clipIds">
	>({
		scheduleMode: "now",
		startDate: formatDateInputInTimeZone(
			new Date(),
			config.workspaceTimezone,
			1,
		),
		timeZone: config.workspaceTimezone,
		postingWindow: { start: "09:00", end: "17:00" },
		frequency: { unit: "hours", value: 2 },
		dstDisambiguation: null,
	});
	const [slots, setSlots] = useState<
		Array<{ clipId: string; scheduledFor: string }>
	>([]);
	const [previewError, setPreviewError] = useState("");
	const [error, setError] = useState("");
	const [copyErrors, setCopyErrors] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [renderBusy, setRenderBusy] = useState(false);
	const [pending, setPending] = useState<BulkSocialScheduleRequest | null>(
		null,
	);
	const [result, setResult] = useState<BulkResult | null>(null);
	const [override, setOverride] = useState("");
	const [approvalBlocked, setApprovalBlocked] = useState(false);
	const [instruction, setInstruction] = useState("");
	const [lockedPhrases, setLockedPhrases] = useState("");
	const [lockedHashtags, setLockedHashtags] = useState("");
	const [replaceScope, setReplaceScope] = useState<string | null>(null);
	const [coverAccount, setCoverAccount] = useState<string | null>(null);
	const generating = useRef(new Set<string>());
	const [, setGenerationTick] = useState(0);
	const generatedCopies = useRef<Record<string, Generated>>({});
	const generationRequests = useRef<
		Record<string, { key: string; signature: string }>
	>({});
	const eligible = useMemo(
		() =>
			config.accounts.filter(
				(a) =>
					a.status === "active" &&
					(a.platform !== "facebook_reels" || config.facebookPublishingEnabled),
			),
		[config.accounts, config.facebookPublishingEnabled],
	);
	const accounts = useMemo(
		() =>
			accountIds.flatMap((id) => {
				const a = eligible.find((a) => a.id === id);
				return a ? [a] : [];
			}),
		[accountIds, eligible],
	);
	const active = clips.find((c) => c.id === activeId) ?? clips[0]!;
	const accepted = new Set(
		result?.items
			.filter((i) => i.status === "succeeded")
			.map((i) => publishingDraftKey(i.clipId, i.accountId)) ?? [],
	);
	const pairs = useMemo(
		() =>
			clips.flatMap((clip) =>
				accounts.map((account) => ({
					clip,
					account,
					key: publishingDraftKey(clip.id, account.id),
				})),
			),
		[clips, accounts],
	);
	const initialized = useRef(false);
	useEffect(() => {
		if (initialized.current) return;
		initialized.current = true;
		try {
			const raw = localStorage.getItem(storageKey);
			const saved = raw
				? savedPublishingSchema.safeParse(JSON.parse(raw))
				: null;
			if (saved?.success) {
				setDrafts(saved.data.drafts);
				if (Object.values(saved.data.drafts).some((draft) => draft.thumbnail)) {
					void publishingRequest<{
						assets: Array<{ id: string; fingerprint: string }>;
					}>("/api/visual-assets")
						.then(({ assets }) => {
							const missing = new Set(
								Object.entries(saved.data.drafts)
									.filter(
										([, draft]) =>
											draft.thumbnail &&
											!assets.some(
												(asset) =>
													asset.id === draft.thumbnail!.assetId &&
													asset.fingerprint === draft.thumbnail!.fingerprint,
											),
									)
									.map(([key]) => key),
							);
							if (!missing.size) return;
							setDrafts((current) =>
								Object.fromEntries(
									Object.entries(current).map(([key, draft]) => [
										key,
										missing.has(key) &&
										draft.thumbnail?.assetId ===
											saved.data.drafts[key]?.thumbnail?.assetId
											? { ...draft, thumbnail: null }
											: draft,
									]),
								),
							);
							setError(
								"A saved cover is no longer available. Review the default cover or choose another before submitting.",
							);
						})
						.catch(() =>
							setError(
								"Saved covers could not be checked. They will be validated again when you submit.",
							),
						);
				}
				setAccountIds(
					eligible.length === 1
						? [eligible[0]!.id]
						: saved.data.accountIds.filter((id) =>
								eligible.some((a) => a.id === id),
							),
				);
				setTiming({
					...saved.data.timing,
					scheduleMode:
						clips.length === 1 && saved.data.timing.scheduleMode === "spread"
							? "scheduled"
							: saved.data.timing.scheduleMode,
					timeZone: config.workspaceTimezone,
				});
			} else if (eligible.length === 1) setAccountIds([eligible[0]!.id]);
			const previousOutcome = localStorage.getItem(outcomeKey);
			if (previousOutcome) {
				const value = JSON.parse(previousOutcome) as BulkResult;
				if (Array.isArray(value.items)) {
					setResult(value);
					setApprovalBlocked(
						value.items.some((i) => i.errorCode === "review_approval_required"),
					);
				}
			}
			const previous = localStorage.getItem(pendingKey);
			if (previous) {
				const parsed = bulkSocialScheduleSchema.safeParse(JSON.parse(previous));
				if (parsed.success) {
					setPending(parsed.data);
					setAccountIds([
						...new Set(parsed.data.items.map((item) => item.accountId)),
					]);
				}
			}
			const savedCopies = localStorage.getItem(`${storageKey}:copy`);
			if (savedCopies) generatedCopies.current = JSON.parse(savedCopies);
			const generations = localStorage.getItem(`${storageKey}:generations`);
			if (generations) generationRequests.current = JSON.parse(generations);
		} catch {
			setError(
				"Browser storage is unavailable. Keep this page open to retain your draft.",
			);
		}
		setRestored(true);
	}, [
		storageKey,
		pendingKey,
		outcomeKey,
		eligible,
		config.workspaceTimezone,
		clips.length,
	]);
	useEffect(() => {
		if (!restored) return;
		try {
			localStorage.setItem(
				storageKey,
				JSON.stringify({ drafts, accountIds, timing }),
			);
		} catch {
			setError("This browser could not save your draft. Keep this page open.");
		}
	}, [restored, drafts, accountIds, timing, storageKey]);
	useEffect(() => {
		if (!restored) return;
		setDrafts((current) => {
			const next = { ...current };
			let changed = false;
			for (const p of pairs) {
				const d = next[p.key];
				if (!d) {
					const blank = blankPublishingDraft(p.clip, p.account.platform);
					const seed =
						generatedCopies.current[
							`${p.clip.id}:${p.clip.editorRevision}:${p.account.platform}`
						];
					next[p.key] = seed
						? applyGeneratedDescription(blank, 0, seed)
						: blank;
					changed = true;
				} else if (d.revision !== p.clip.editorRevision) {
					next[p.key] = {
						...d,
						revision: p.clip.editorRevision,
						thumbnail: null,
						editVersion: d.editVersion + 1,
					};
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, [restored, pairs]);
	const refreshExports = useCallback(async () => {
		const response = await publishingRequest<{ exports: unknown }>(
			`/api/projects/${config.projectId}/exports/current`,
		);
		setExports(clipExportSnapshotSchema.array().parse(response.exports));
	}, [config.projectId]);
	const staleRevision = exports.some((item) =>
		clips.some(
			(clip) =>
				clip.id === item.clipId &&
				item.currentEditorRevision > clip.editorRevision,
		),
	);
	useEffect(() => {
		if (staleRevision) router.refresh();
	}, [staleRevision, router]);
	useEffect(() => {
		if (!open) return;
		void refreshExports().catch((e) => setError(e.message));
		const timer = setInterval(
			() => void refreshExports().catch((e) => setError(e.message)),
			5000,
		);
		return () => clearInterval(timer);
	}, [open, refreshExports]);
	useEffect(() => {
		let alive = true;
		for (const account of accounts) {
			if (options[account.id] || optionErrors[account.id]) continue;
			void publishingRequest<Options>(
				`/api/projects/${config.projectId}/social-accounts/${account.id}/publishing-options`,
			)
				.then((value) => {
					if (alive) setOptions((o) => ({ ...o, [account.id]: value }));
				})
				.catch((e) => {
					if (alive)
						setOptionErrors((o) => ({ ...o, [account.id]: e.message }));
				});
		}
		return () => {
			alive = false;
		};
	}, [accounts, config.projectId, options, optionErrors]);
	const timingSignature = JSON.stringify({
		...timing,
		clipIds: clips.map((c) => c.id),
	});
	useEffect(() => {
		if (!open || JSON.parse(timingSignature).scheduleMode === "now") {
			setSlots([]);
			setPreviewError("");
			return;
		}
		let alive = true;
		setSlots([]);
		const timer = setTimeout(
			() =>
				void publishingRequest<{
					slots: Array<{ clipId: string; scheduledFor: string }>;
				}>(
					`/api/projects/${config.projectId}/campaign-operations/schedule/preview`,
					JSON.parse(timingSignature),
				)
					.then((v) => {
						if (alive) {
							setSlots(v.slots);
							setPreviewError("");
						}
					})
					.catch((e) => {
						if (alive) setPreviewError(e.message);
					}),
			250,
		);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [timingSignature, open, config.projectId]);
	function update(key: string, patch: Partial<PublishingDraft>) {
		setDrafts((current) => {
			const d = current[key];
			return d
				? {
						...current,
						[key]: {
							...d,
							...patch,
							edited: true,
							editVersion: d.editVersion + 1,
						},
					}
				: current;
		});
		setError("");
	}
	async function generate(
		clip: ClipSnapshot,
		targets: typeof pairs,
		force = false,
	) {
		const platforms = [...new Set(targets.map((t) => t.account.platform))];
		if (!platforms.length) return;
		const requestName = `${clip.id}:${clip.editorRevision}:${platforms.join(",")}`;
		if (generating.current.has(requestName)) return;
		generating.current.add(requestName);
		setGenerationTick((n) => n + 1);
		const versions = new Map(
			targets.map((t) => [t.key, draftRef.current[t.key]?.editVersion ?? 0]),
		);
		const input = {
			clipId: clip.id,
			platforms,
			campaignNote: "",
			revisionInstruction: instruction || undefined,
			lockedPhrases: lockedPhrases
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
			lockedHashtags: lockedHashtags.match(/#[^\s#]+/gu) ?? [],
		};
		const signature = JSON.stringify({
			...input,
			editorRevision: clip.editorRevision,
		});
		const previous = generationRequests.current[requestName];
		const key =
			!force && previous?.signature === signature
				? previous.key
				: crypto.randomUUID();
		generationRequests.current[requestName] = { key, signature };
		try {
			localStorage.setItem(
				`${storageKey}:generations`,
				JSON.stringify(generationRequests.current),
			);
		} catch {}
		try {
			const response = await publishingRequest<{ variants: Generated[] }>(
				`/api/projects/${config.projectId}/assisted-copy/generations`,
				{ ...input, idempotencyKey: key },
			);
			for (const v of response.variants)
				generatedCopies.current[
					`${clip.id}:${clip.editorRevision}:${v.platform}`
				] = v;
			try {
				localStorage.setItem(
					`${storageKey}:copy`,
					JSON.stringify(generatedCopies.current),
				);
			} catch {}
			setDrafts((current) => {
				const next = { ...current };
				for (const t of targets) {
					const d = next[t.key];
					const variant = response.variants.find(
						(v) => v.platform === t.account.platform,
					);
					if (d && variant && d.revision === clip.editorRevision)
						next[t.key] = applyGeneratedDescription(
							d,
							versions.get(t.key)!,
							variant,
						);
				}
				return next;
			});
			setCopyErrors((current) => {
				const next = { ...current };
				targets.forEach((t) => {
					delete next[t.key];
				});
				return next;
			});
		} catch (e) {
			setCopyErrors((current) => ({
				...current,
				...Object.fromEntries(
					targets.map((t) => [
						t.key,
						e instanceof Error
							? e.message
							: "Description generation failed. Write one or retry.",
					]),
				),
			}));
		} finally {
			generating.current.delete(requestName);
			setGenerationTick((n) => n + 1);
		}
	}
	const generateInBackground = useEffectEvent(
		(clip: ClipSnapshot, targets: typeof pairs) => generate(clip, targets),
	);
	useEffect(() => {
		if (!restored || !open || !config.assistedCopyEnabled || pending) return;
		for (const clip of clips) {
			if (generating.current.size >= 2) break;
			const missing = pairs.filter(
				(p) =>
					p.clip.id === clip.id &&
					drafts[p.key] &&
					!drafts[p.key]!.generated &&
					!drafts[p.key]!.edited &&
					!copyErrors[p.key],
			);
			if (missing.length) void generateInBackground(clip, missing);
		}
	}, [
		restored,
		open,
		pairs,
		clips,
		config.assistedCopyEnabled,
		drafts,
		copyErrors,
		pending,
	]);
	async function regenerate(scope: string) {
		setReplaceScope(null);
		for (const clip of scope !== "all" ? [active] : clips) {
			await generate(
				clip,
				pairs.filter(
					(p) =>
						p.clip.id === clip.id &&
						!accepted.has(p.key) &&
						(scope === "all" || scope === "current" || scope === p.key),
				),
				true,
			);
		}
	}
	function requestRegeneration(scope: "current" | "all") {
		if (
			pairs.some(
				(p) =>
					(scope === "all" || p.clip.id === active.id) && drafts[p.key]?.edited,
			)
		)
			setReplaceScope(scope);
		else void regenerate(scope);
	}
	function issues(p: (typeof pairs)[number]) {
		const d = drafts[p.key];
		if (accepted.has(p.key)) return [];
		if (!d) return ["Preparing draft…"];
		const result: string[] = [];
		if (d.reviewedRevision !== p.clip.editorRevision)
			result.push("Review this clip's updated video before submitting.");
		if (
			!currentPublicationExport(
				p.clip,
				p.account.platform,
				exports,
				preferredExportId,
			)
		)
			result.push("Prepare a compatible video.");
		if (d.deliveryMode === "direct" && !d.caption.trim())
			result.push("Write a description.");
		if (
			d.caption.trim().length >
			SOCIAL_PROVIDER_CAPABILITIES[p.account.platform].textLimit
		)
			result.push("Description exceeds the character limit.");
		if (optionErrors[p.account.id]) result.push(optionErrors[p.account.id]!);
		if (p.account.platform === "tiktok") {
			const o = options[p.account.id];
			if (!o) result.push("Loading TikTok settings…");
			else if (d.deliveryMode === "tiktok_inbox" && !o.inboxEnabled)
				result.push("Reconnect TikTok to allow inbox uploads.");
			else if (d.deliveryMode === "direct") {
				if (!o.directEnabled)
					result.push("Reconnect TikTok to allow direct publication.");
				if (
					!o.privacyOptions.includes(
						String(d.settings.tiktokPrivacyLevel ?? ""),
					)
				)
					result.push("Choose visibility.");
				if (p.clip.durationSec > o.maximumDurationSec)
					result.push("This video exceeds the account's duration limit.");
			}
		}
		return result;
	}
	async function prepare() {
		setRenderBusy(true);
		setError("");
		try {
			await publishingRequest(
				activeExport?.status === "failed"
					? `/api/projects/${config.projectId}/clips/${active.id}/exports/${activeExport.id}/retry`
					: `/api/projects/${config.projectId}/clips/${active.id}/exports`,
				{
					expectedRevision: active.editorRevision,
					aspectRatios: ["9:16"],
					resolution: config.can1080pExport ? "1080p" : "720p",
				},
			);
			await refreshExports();
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "The video could not be prepared.",
			);
		} finally {
			setRenderBusy(false);
		}
	}
	async function submit() {
		setBusy(true);
		setError("");
		try {
			let payload = pending;
			if (!payload) {
				const outstanding = pairs.filter((p) => !accepted.has(p.key));
				payload = bulkSocialScheduleSchema.parse({
					...timing,
					idempotencyKey: crypto.randomUUID(),
					items: outstanding.map((p) => {
						const d = drafts[p.key]!;
						const media = currentPublicationExport(
							p.clip,
							p.account.platform,
							exports,
							preferredExportId,
						)!;
						return {
							clipId: p.clip.id,
							accountId: p.account.id,
							platform: p.account.platform,
							deliveryMode: d.deliveryMode,
							expectedEditorRevision: p.clip.editorRevision,
							exportId: media.export.id,
							exportVariantId: media.variant.id,
							aspectRatio: media.variant.aspectRatio,
							resolution: media.variant.resolution,
							copy: {
								variantId: d.variantId,
								caption: d.caption.trim(),
								hashtags: [],
								title:
									d.deliveryMode === "direct" &&
									p.account.platform !== "tiktok" &&
									SOCIAL_PROVIDER_CAPABILITIES[p.account.platform].titleField
										? d.title.trim() || null
										: null,
							},
							providerSettings:
								d.deliveryMode === "direct"
									? {
											...d.settings,
											...(p.account.platform === "tiktok"
												? {
														disableComment:
															options[p.account.id]?.commentDisabled ||
															d.settings.disableComment === true,
														disableDuet:
															options[p.account.id]?.duetDisabled ||
															d.settings.disableDuet === true,
														disableStitch:
															options[p.account.id]?.stitchDisabled ||
															d.settings.disableStitch === true,
													}
												: {}),
										}
									: {},
							thumbnail: d.deliveryMode === "direct" ? d.thumbnail : null,
						};
					}),
					reviewOverrideReason: override.trim() || null,
				});
				localStorage.setItem(pendingKey, JSON.stringify(payload));
				setPending(payload);
			}
			const outcome = await publishingRequest<BulkResult>(
				`/api/projects/${config.projectId}/campaign-operations/schedule`,
				payload,
			);
			if (!outcome.items || !outcome.counts)
				throw new Error(
					"The submission result was incomplete. Check the previous submission before trying again.",
				);
			const merged = {
				...outcome,
				items: [
					...(result?.items.filter(
						(i) =>
							i.status === "succeeded" &&
							!outcome.items.some(
								(next) =>
									next.clipId === i.clipId && next.accountId === i.accountId,
							),
					) ?? []),
					...outcome.items,
				],
			};
			localStorage.setItem(outcomeKey, JSON.stringify(merged));
			setResult(merged);
			if (outcome.status === "running") {
				setError(
					"Your submission is still being checked. Check again to retrieve its result.",
				);
				return;
			}
			localStorage.removeItem(pendingKey);
			setPending(null);
			if (outcome.items.every((i) => i.status === "succeeded")) {
				localStorage.removeItem(outcomeKey);
				await onSubmitted(merged);
			} else {
				setApprovalBlocked(
					outcome.items.some((i) => i.errorCode === "review_approval_required"),
				);
				setError(
					`${outcome.counts.succeeded} submitted. Review the items that need attention below.`,
				);
				await onSubmitted(merged);
			}
		} catch (e) {
			if (
				e instanceof PublishingRequestError &&
				e.status >= 400 &&
				e.status < 500 &&
				e.status !== 408 &&
				e.status !== 409 &&
				e.status !== 429
			) {
				localStorage.removeItem(pendingKey);
				setPending(null);
			}
			setError(
				e instanceof Error
					? e.message
					: "Submission could not be confirmed. Check the previous submission.",
			);
		} finally {
			setBusy(false);
		}
	}
	const activeExport = exports.find(
		(e) =>
			e.clipId === active.id &&
			e.editorRevision === active.editorRevision &&
			!e.isOlderVersion,
	);
	const activeMediaReady =
		accounts.length > 0 &&
		accounts.every(
			(a) =>
				!!currentPublicationExport(
					active,
					a.platform,
					exports,
					preferredExportId,
				),
		);
	const preparingVideo =
		renderBusy ||
		(!!activeExport && ["queued", "rendering"].includes(activeExport.status));
	const disabled = busy || !!pending;
	const unresolved = pairs.filter((p) => !accepted.has(p.key));
	const issueCount = unresolved.reduce((n, p) => n + issues(p).length, 0);
	const inboxCount = unresolved.filter(
		(p) => drafts[p.key]?.deliveryMode === "tiktok_inbox",
	).length;
	const directCount = unresolved.length - inboxCount;
	const coverPair = coverAccount
		? pairs.find(
				(p) => p.clip.id === active.id && p.account.id === coverAccount,
			)
		: null;
	const coverMedia = coverPair
		? currentPublicationExport(
				active,
				coverPair.account.platform,
				exports,
				preferredExportId,
			)
		: null;
	return (
		<>
			<Drawer.Body p="0" overflow="hidden" display="grid" gridTemplateColumns={{base:"minmax(0, 1fr)", md:"240px minmax(0, 1fr)"}} gridTemplateRows={{base:"auto minmax(0, 1fr)",md:"minmax(0, 1fr)"}} minH="0">
				<chakra.fieldset disabled={disabled || !restored} border="0" m="0" minW="0" p="4" bg="bg.subtle" borderRightWidth={{base: "0", md: "1px"}} borderBottomWidth={{base:"1px",md:"0"}} borderColor="border" overflowY="auto">
									<Stack gap="6">
										<Flex justify="space-between" gap="2" align="center">
											<Text as="h3" fontSize="sm" fontWeight="semibold">
												Publish to social
											</Text>
											
										</Flex>
										<Flex gap="2" wrap="wrap" direction={{base:"row",md:"column"}}>
											{config.accounts.map((account) => {
												const enabled = eligible.some(
													(a) => a.id === account.id,
												);
												return (
													<Box
														key={account.id}
														py="2">
														<Checkbox
															checked={accountIds.includes(account.id)}
															disabled={!enabled}
															onCheckedChange={(checked) =>
																setAccountIds((current) =>
																	checked
																		? [...current, account.id]
																		: current.filter((id) => id !== account.id),
																)
															}
														>
															<Flex gap="3" align="center" minW="0">
																<Box position="relative" flexShrink={0}>
<Avatar.Root size="sm"><Avatar.Fallback name={account.displayName}/><Avatar.Image src={account.avatarUrl ?? undefined}/></Avatar.Root>
<Box position="absolute" bottom="-1" right="-1" bg="bg.panel" borderRadius="full" p="0.5"><SocialPlatformMark
																	platform={account.platform}
																	size="4"
																/></Box></Box>
																<Text fontSize="sm" overflowWrap="anywhere">{account.handle || account.displayName}</Text>
															</Flex>
														</Checkbox>
													</Box>
												);
											})}
										</Flex>
										<Button variant="outline" size="sm" width="full" bg="bg.panel" asChild>
												<Link
													aria-label="Manage accounts"
													title="Manage accounts"
													href={`/settings/social-accounts?returnTo=${encodeURIComponent(`/projects/${config.projectId}?publishClips=${clips.map((c) => c.id).join(",")}`)}`}
												>
													<Settings2 size={15} /> Manage accounts
												</Link>
											</Button>
{!config.accounts.length && (
											<Text fontSize="sm" color="fg.muted">
												Connect a social account to publish this clip.
											</Text>
										)}
										{config.accounts.length > 0 && !accounts.length && (
											<Text fontSize="xs" color="fg.muted">
												Choose the accounts for this selection.
											</Text>
										)}
									</Stack></chakra.fieldset>
				<Stack
					overflowY="auto"
 minH="0" css={{"& > *": {flexShrink: 0}}}
					flex="1"
					minW="0"
					p={{ base: "4", md: "7" }}
 bg="bg.subtle"
					gap="7"
				>
					{!restored ? (
						<Spinner />
					) : (
						<>
							{clips.length > 1 && (
					<Stack
						as="nav"
						aria-label="Selected clips"
 flexShrink={0} minH="132px" overflowY="hidden"
						width="full"
						direction="row"
						bg="bg.subtle"
						borderBottomWidth="1px"
						borderColor="border"
						overflowX="auto"
						p="2"
						gap="2"
						display={{ base: "none", md: "flex" }}
					>
						{clips.map((clip) => {
							const count = pairs
								.filter((p) => p.clip.id === clip.id)
								.reduce((n, p) => n + issues(p).length, 0);
							return (
								<Button
									key={clip.id}
									variant="ghost" borderWidth="0" bg={active.id === clip.id ? "bg.panel" : "transparent"} _hover={{ bg: "bg.panel" }}
									aria-current={active.id === clip.id ? "true" : undefined}
									width="180px" minW="180px" maxW="180px" flexShrink={0} whiteSpace="normal"
									textAlign="start"
									h="auto" minH="112px"
									p="3"
									justifyContent="start"
									onClick={() => setActiveId(clip.id)}
								>
									<Stack gap="2" minW="0" width="full">
										<Flex align="center" gap="2">
											{exports
												.find((e) => e.clipId === clip.id)
												?.variants.find((v) => v.previewUrl)?.previewUrl ? (
												<PublishingPreview key={exports.find(e => e.clipId === clip.id)?.variants.find(v => v.previewUrl)?.id}
													muted
													preload="metadata"
													aria-label={`Preview of ${clip.title ?? clip.hookText}`}
													src={
														exports
															.find((e) => e.clipId === clip.id)
															?.variants.find((v) => v.previewUrl)
															?.previewUrl ?? undefined
													}
													style={{
														width: 32,
														height: 44,
														objectFit: "cover",
														borderRadius: 4,
													}}
												/>
											) : (
												<Flex width="32px" height="44px" flexShrink={0} align="center" justify="center" bg="bg.panel" borderRadius="4px"><Film size={16} /></Flex>
											)}
											<Text fontSize="xs">
												{formatDuration(clip.durationSec)}
											</Text>
										</Flex>
										<Text fontSize="xs" lineClamp={2} minH="32px">
											{clip.title ?? clip.hookText}
										</Text>
										<Text
											fontSize="10px"
											color={count ? "fg.muted" : "success.fg"}
										>
											{count ? "Needs review" : "Ready"}
										</Text>
									</Stack>
								</Button>
							);
						})}
					</Stack>
				)}
{clips.length > 1 && (
								<Field.Root display={{ md: "none" }}>
									<Field.Label>Clip</Field.Label>
									<NativeSelect.Root>
										<NativeSelect.Field
											value={active.id}
											onChange={(e) => setActiveId(e.target.value)}
										>
											{clips.map((c) => (
												<option value={c.id} key={c.id}>
													{c.title ?? c.hookText}
												</option>
											))}
										</NativeSelect.Field>
										<NativeSelect.Indicator />
									</NativeSelect.Root>
								</Field.Root>
							)}
							{pending && (
								<Box
									bg="bg.subtle"
									borderWidth="1px"
									borderColor="border"
									borderRadius="l2"
									p="3"
								>
									<Text fontSize="sm">
										A previous submission needs its result checked. Your saved
										request will be reused.
									</Text>
								</Box>
							)}
							<chakra.fieldset
								disabled={disabled}
								border="0"
								p="0"
								m="0"
								minW="0"
							>
								<Stack gap="7">
{!activeMediaReady && (
										<Flex
											justify="space-between"
											gap="3"
											align="center"
											px="1"
											py="2"
											bg="transparent"
											borderRadius="l2"
										>
											<Box>
												<Text fontSize="xs" fontWeight="medium">
													{active.title ?? active.hookText}
												</Text>
												<Text fontSize="11px" color="fg.muted">
													{formatDuration(active.durationSec)} ·{" "}
													{activeMediaReady ? (
														<CheckCircle2 size={13} aria-label="Video ready" />
													) : (
														"Video required"
													)}
												</Text>
											</Box>
											{!activeMediaReady && (
												<Button
													variant="outline"
													size="xs"
													disabled={preparingVideo}
													onClick={() => void prepare()}
												>
													<Film size={13} />
													{preparingVideo
														? `Preparing ${activeExport?.progress ?? 0}%`
														: activeExport?.status === "failed"
															? "Retry video"
															: "Prepare video"}
												</Button>
											)}
										</Flex>
									)}
									{config.assistedCopyEnabled ? (
<Stack bg="bg.panel" p={{base:"4",md:"6"}} borderRadius="2xl" gap="4">
<Field.Root gap="3">
<Field.Label>Regenerate descriptions</Field.Label>
<Textarea aria-label="Regeneration instructions" value={instruction} rows={3} bg="bg.subtle" borderColor="transparent" p="4" lineHeight="1.7" placeholder="Adjust the tone or tell us what to emphasize." onChange={(e) => setInstruction(e.target.value)} />
</Field.Root>
<Flex gap="2" wrap="wrap" align="center">
{[{label:"Tone & voice", text:"Use our Tone & Voice"},{label:"Hashtags",text:"Add relevant hashtags"},{label:"Call to action",text:"Include a clear CTA"}].map(({label,text}) => <Button key={text} aria-label={text} variant="ghost" size="xs" onClick={() => setInstruction(v => [v,text].filter(Boolean).join(". "))}>{label}</Button>)}
<Button ms="auto" size="sm" variant="outline" disabled={generating.current.size > 0} onClick={() => requestRegeneration(clips.length > 1 ? "all" : "current")}><Sparkles size={14}/>Regenerate all</Button>
</Flex>
<Collapsible.Root>
<Collapsible.Trigger asChild><Button variant="ghost" size="xs"><Settings2 size={14}/>AI options<ChevronDown size={13}/></Button></Collapsible.Trigger>
<Collapsible.Content><Stack gap="4" pt="4" borderTopWidth="1px" borderColor="border" mt="3">
<Field.Root><Field.Label>Keep these phrases</Field.Label><Input value={lockedPhrases} placeholder="Separate phrases with commas" onChange={e=>setLockedPhrases(e.target.value)}/></Field.Root>
<Field.Root><Field.Label>Keep these hashtags</Field.Label><Input value={lockedHashtags} placeholder="#YourBrand" onChange={e=>setLockedHashtags(e.target.value)}/></Field.Root>
{clips.length > 1 && <Button alignSelf="start" variant="outline" size="sm" disabled={generating.current.size > 0} onClick={() => requestRegeneration("current")}>Regenerate this clip</Button>}
</Stack></Collapsible.Content></Collapsible.Root>
</Stack>
) : <Text fontSize="xs" color="fg.muted">Automatic descriptions require a Creator plan. You can write your own description.</Text>}
{accounts.map((account) => {
										const key = publishingDraftKey(active.id, account.id);
										const d = drafts[key];
										if (!d) return null;
										const capability =
											SOCIAL_PROVIDER_CAPABILITIES[account.platform];
										const accountOptions = options[account.id];
										const warnings = issues({ clip: active, account, key });
										const media = currentPublicationExport(
											active,
											account.platform,
											exports,
											preferredExportId,
										);
										const submitted = accepted.has(key);
										return (
											<Stack
												key={key}
												gap="4"
												borderWidth="0"
												borderColor="border"
												borderRadius="2xl"
												p={{ base: "5", md: "7" }}
												bg="bg.panel"
												opacity={submitted ? 0.6 : 1}
											>
												<Flex align="center" justify="space-between" gap="2">
													<Flex gap="2" align="center">
														<SocialPlatformMark
															platform={account.platform}
															size="4"
														/>
														<Text fontSize="sm" fontWeight="semibold">
															{accounts.length > 1
																? account.displayName
																: SOCIAL_PLATFORM_LABELS[account.platform]}
														</Text>
													</Flex>
													{submitted ? (
														<Text fontSize="xs" color="success.fg">
															Submitted
														</Text>
													) : (
														config.assistedCopyEnabled && (
															<Button
																aria-label="Regenerate"
																title="Regenerate"
																variant="ghost"
																size="xs"
																disabled={generating.current.size > 0}
																onClick={() => {
																	if (d.edited) setReplaceScope(key);
																	else
																		void generate(
																			active,
																			[{ clip: active, account, key }],
																			true,
																		);
																}}
															>
																<Sparkles size={15} />
															</Button>
														)
													)}
												</Flex>
												<chakra.fieldset
													disabled={submitted}
													border="0"
													p="0"
													m="0"
												>
													<Stack gap="6">
														{account.platform === "tiktok" && (
															<Field.Root>
																<Field.Label>Delivery</Field.Label>
																<NativeSelect.Root>
																	<NativeSelect.Field
																		value={d.deliveryMode}
																		onChange={(e) =>
																			update(key, {
																				deliveryMode: e.target
																					.value as PublishingDraft["deliveryMode"],
																			})
																		}
																	>
																		<option value="direct">
																			Publish directly
																		</option>
																		<option value="tiktok_inbox">
																			Send to TikTok inbox
																		</option>
																	</NativeSelect.Field>
																	<NativeSelect.Indicator />
																</NativeSelect.Root>
															</Field.Root>
														)}
														{d.deliveryMode === "tiktok_inbox" && (
															<Text fontSize="xs" color="fg.muted">
																Finish editing and publish in TikTok. Copy your
																caption below.
															</Text>
														)}
														{d.deliveryMode === "direct" &&
															capability.titleField &&
															account.platform !== "tiktok" && (
																<Field.Root>
																	<Field.Label>Title</Field.Label>
																	<Input
																		value={d.title}
																		maxLength={100}
																		onChange={(e) =>
																			update(key, { title: e.target.value })
																		}
																	/>
																</Field.Root>
															)}
														<Field.Root
															invalid={
																d.deliveryMode === "direct" &&
																d.caption.length > capability.textLimit
															}
														>
															<Flex
																width="full"
																justify="space-between"
																align="center"
															>
																<Field.Label mb="0">
																	{d.deliveryMode === "tiktok_inbox"
																		? "Suggested description"
																		: "Description"}
																</Field.Label>
																{generating.current.size > 0 &&
																	!d.generated &&
																	!d.edited && (
																		<Flex gap="1" align="center">
																			<Spinner size="xs" />
																			<Text fontSize="10px" color="fg.muted">
																				Writing…
																			</Text>
																		</Flex>
																	)}
															</Flex>
															<Textarea aria-label="Description"
																value={d.caption}
																rows={9}
minH="220px" bg="bg.subtle" borderColor="transparent" p="4" lineHeight="1.8"
																resize="vertical"
																placeholder={
																	config.assistedCopyEnabled
																		? "Write a caption…"
																		: "Write a caption…"
																}
																onChange={(e) =>
																	update(key, { caption: e.target.value })
																}
															/>
															<Flex width="full" justify="space-between">
																<Button
																	aria-label="Copy description"
																	title="Copy description"
																	variant="ghost"
																	size="xs"
																	disabled={!d.caption}
																	onClick={() =>
																		void navigator.clipboard
																			.writeText(d.caption)
																			.catch(() =>
																				setError(
																					"The description could not be copied.",
																				),
																			)
																	}
																>
																	<Copy size={15} />
																</Button>
																<Text fontSize="10px" color="fg.muted">
																	{d.caption.length}/{capability.textLimit}
																</Text>
															</Flex>
															<Field.ErrorText>
																Shorten the description before publishing.
															</Field.ErrorText>
														</Field.Root>
														{copyErrors[key] && (
															<Text
																role="status"
																color="warning.fg"
																fontSize="xs"
															>
																{copyErrors[key]} You can write a description or
																regenerate it.
															</Text>
														)}
														{d.deliveryMode === "direct" && (
															<>
																{capability.thumbnailSources.length > 0 && (
																	<Flex
																		align="center"
																		justify="space-between"
																		gap="2"
																	>
																		<Text fontSize="xs" color="fg.muted">
																			{d.thumbnail
																				? "Custom cover selected"
																				: "Default cover"}
																		</Text>
																		<Flex gap="2">
																			{d.thumbnail && (
																				<Button
																					size="xs"
																					variant="ghost"
																					onClick={() =>
																						update(key, { thumbnail: null })
																					}
																				>
																					Remove
																				</Button>
																			)}
																			<Button
																				size="xs"
																				variant="outline"
																				disabled={
																					!media ||
																					!config.customThumbnailsEnabled
																				}
																				onClick={() =>
																					setCoverAccount(account.id)
																				}
																			>
																				<ImagePlus size={14} /> Cover
																			</Button>
																		</Flex>
																	</Flex>
																)}
																{(account.platform === "youtube_shorts" ||
																	account.platform === "tiktok" ||
																	account.platform === "linkedin") && (
																	<Field.Root>
																		<Field.Label>Visibility</Field.Label>
																		<Select ariaLabel="Visibility" placeholder="Choose visibility" disabled={disabled || submitted} items={account.platform === "tiktok" ? (accountOptions?.privacyOptions ?? []).map(value => ({value,label: ({PUBLIC_TO_EVERYONE:"Public",SELF_ONLY:"Only me",MUTUAL_FOLLOW_FRIENDS:"Friends",FOLLOWER_OF_CREATOR:"Followers"} as Record<string,string>)[value] ?? value})) : account.platform === "youtube_shorts" ? [{value:"public",label:"Public"},{value:"unlisted",label:"Unlisted"},{value:"private",label:"Private"}] : [{value:"PUBLIC",label:"Public"},{value:"CONNECTIONS",label:"Connections"}]} value={String(d.settings[account.platform === "tiktok" ? "tiktokPrivacyLevel" : account.platform === "youtube_shorts" ? "youtubePrivacyStatus" : "linkedinVisibility"] ?? "")} onValueChange={value => update(key, {settings: {...d.settings, [account.platform === "tiktok" ? "tiktokPrivacyLevel" : account.platform === "youtube_shorts" ? "youtubePrivacyStatus" : "linkedinVisibility"]: value}})} />
																	</Field.Root>
																)}
																{account.platform === "instagram_reels" && (
																	<Checkbox
																		checked={d.settings.shareToFeed !== false}
																		onCheckedChange={(checked) =>
																			update(key, {
																				settings: {
																					...d.settings,
																					shareToFeed: checked,
																				},
																			})
																		}
																	>
																		Share to feed
																	</Checkbox>
																)}
																{account.platform === "tiktok" && (
																	<Collapsible.Root>
																		<Collapsible.Trigger asChild>
																			<Button variant="ghost" size="xs">
																				Interaction settings
																				<ChevronDown size={12} />
																			</Button>
																		</Collapsible.Trigger>
																		<Collapsible.Content>
																			<Stack gap="3" pt="3">
																				{[
																					[
																						"disableComment",
																						"Allow comments",
																						accountOptions?.commentDisabled,
																					],
																					[
																						"disableDuet",
																						"Allow Duet",
																						accountOptions?.duetDisabled,
																					],
																					[
																						"disableStitch",
																						"Allow Stitch",
																						accountOptions?.stitchDisabled,
																					],
																				].map(([name, label, restricted]) => (
																					<Checkbox
																						key={String(name)}
																						disabled={restricted === true}
																						checked={
																							restricted !== true &&
																							d.settings[String(name)] !== true
																						}
																						onCheckedChange={(checked) =>
																							update(key, {
																								settings: {
																									...d.settings,
																									[String(name)]: !checked,
																								},
																							})
																						}
																					>
																						{String(label)}
																					</Checkbox>
																				))}
																				<Checkbox
																					checked={d.settings.isAigc === true}
																					onCheckedChange={(checked) =>
																						update(key, {
																							settings: {
																								...d.settings,
																								isAigc: checked,
																							},
																						})
																					}
																				>
																					AI-generated content
																				</Checkbox>
																			</Stack>
																		</Collapsible.Content>
																	</Collapsible.Root>
																)}
															</>
														)}
														{d.reviewedRevision !== active.editorRevision && (
															<Checkbox
																checked={false}
																onCheckedChange={(checked) => {
																	if (checked)
																		update(key, {
																			reviewedRevision: active.editorRevision,
																		});
																}}
															>
																I reviewed this clip’s updated video and
																description.
															</Checkbox>
														)}
														{optionErrors[account.id] && (
															<Button
																size="xs"
																variant="outline"
																onClick={() =>
																	void publishingRequest<Options>(
																		`/api/projects/${config.projectId}/social-accounts/${account.id}/publishing-options`,
																	)
																		.then((value) => {
																			setOptions((o) => ({
																				...o,
																				[account.id]: value,
																			}));
																			setOptionErrors((o) => {
																				const next = { ...o };
																				delete next[account.id];
																				return next;
																			});
																		})
																		.catch((e) => setError(e.message))
																}
															>
																Retry account settings
															</Button>
														)}
														{warnings.length > 0 && (
															<Stack gap="1">
																{warnings.map((w) => (
																	<Text
																		key={w}
																		fontSize="xs"
																		color="warning.fg"
																	>
																		{w}
																	</Text>
																))}
															</Stack>
														)}
														{result?.items
															.filter(
																(i) =>
																	i.clipId === active.id &&
																	i.accountId === account.id &&
																	i.status !== "succeeded",
															)
															.map((i) => (
																<Text
																	key={`${i.clipId}:${i.accountId}`}
																	fontSize="xs"
																	color="danger.fg"
																>
																	This post needs attention.{" "}
																	{i.errorCode?.replaceAll("_", " ")}
																</Text>
															))}
													</Stack>
												</chakra.fieldset>
											</Stack>
										);
									})}
									{replaceScope && (
										<Box
											p="3"
											borderWidth="1px"
											borderColor="border.emphasized"
											borderRadius="l2"
										>
											<Text fontSize="sm" mb="3">
												Replace edited descriptions for{" "}
												{replaceScope === "all"
													? "all selected clips"
													: replaceScope === "current"
														? "this clip"
														: "this account’s description"}
												?
											</Text>
											<Flex gap="2">
												<Button
													size="sm"
													onClick={() => void regenerate(replaceScope)}
												>
													Replace descriptions
												</Button>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => setReplaceScope(null)}
												>
													Keep edits
												</Button>
											</Flex>
										</Box>
									)}
									{approvalBlocked && (
										<Field.Root>
											<Field.Label>Review approval required</Field.Label>
											{config.canOverrideReview ? (
												<>
													<Field.HelperText>
														Provide a reason to publish without the required
														approval.
													</Field.HelperText>
													<Textarea
														value={override}
														onChange={(e) => setOverride(e.target.value)}
														maxLength={500}
													/>
												</>
											) : (
												<Field.HelperText>
													Request approval in the Review tab before publishing.
												</Field.HelperText>
											)}
										</Field.Root>
									)}
								</Stack>
							</chakra.fieldset>
						</>
					)}
				</Stack>
			</Drawer.Body>
			<Drawer.Footer
				flexDirection="column"
				alignItems="stretch"
				gap="3"
				flexShrink={0}
				px={{ base: "4", md: "6" }}
				py="4"
				borderTopWidth="0"
				borderColor="border"
				bg="bg.panel"
			>
				{timing.scheduleMode !== "now" && (<chakra.fieldset disabled={disabled} border="0" p={{base:"3",md:"5"}} m="0" bg="bg.subtle" borderRadius="xl" maxH="40dvh" overflowY="auto">
					<Stack gap="4"><Flex justify="space-between" align="center"><Text fontSize="sm" fontWeight="medium">Schedule posts</Text><Text fontSize="xs" color="fg.muted">{config.workspaceTimezone}</Text></Flex>
						
						
							<>
								<Flex gap="4" align="end" wrap="wrap">
									<Field.Root flex="1" minW="130px">
										<Field.Label fontSize="xs">Date</Field.Label>
										<DatePicker ariaLabel="Date" width="full" value={timing.startDate} disabled={disabled} onValueChange={(startDate) => setTiming(t => ({...t, startDate}))} />
									</Field.Root>
									<Field.Root flex="1" minW="100px">
										<Field.Label fontSize="xs">
											{inboxCount && !directCount
												? "Inbox delivery time"
												: "Time"}
										</Field.Label>
										<TimePicker ariaLabel="Time" value={timing.postingWindow.start} disabled={disabled} onValueChange={value => setTiming(t => ({...t, postingWindow: {...t.postingWindow, start: value}}))} />
									</Field.Root>
									{clips.length > 1 && (
										<Checkbox mb="2"
											checked={timing.scheduleMode === "spread"}
											onCheckedChange={(checked) =>
												setTiming((t) => ({
													...t,
													scheduleMode: checked ? "spread" : "scheduled",
												}))
											}
										>
											Spread out
										</Checkbox>
									)}
								</Flex>
								{timing.scheduleMode === "spread" && (
									<Flex gap="3" align="end">
										<Field.Root>
											<Field.Label fontSize="xs">Posting hours end</Field.Label>
											<TimePicker ariaLabel="Posting hours end" value={timing.postingWindow.end} disabled={disabled} onValueChange={value => setTiming(t => ({...t, postingWindow: {...t.postingWindow, end: value}}))} />
										</Field.Root>
										<Field.Root>
											<Field.Label fontSize="xs">Every</Field.Label>
											<Input
												size="sm"
												type="number"
												min="1"
												max={timing.frequency.unit === "hours" ? 24 : 30}
												value={timing.frequency.value}
												onChange={(e) =>
													setTiming((t) => ({
														...t,
														frequency: {
															...t.frequency,
															value: Number(e.target.value),
														},
													}))
												}
											/>
										</Field.Root>
										<Field.Root>
											<Field.Label fontSize="xs">Unit</Field.Label>
											<NativeSelect.Root size="sm">
												<NativeSelect.Field
													value={timing.frequency.unit}
													onChange={(e) =>
														setTiming((t) => ({
															...t,
															frequency: {
																unit: e.target.value as "hours" | "days",
																value: t.frequency.value,
															},
														}))
													}
												>
													<option value="hours">Hours</option>
													<option value="days">Days</option>
												</NativeSelect.Field>
											</NativeSelect.Root>
										</Field.Root>
									</Flex>
								)}
								{previewError && (
									<Text fontSize="xs" color="danger.fg">
										{previewError}
									</Text>
								)}
								{previewError.toLowerCase().includes("twice") && (
									<NativeSelect.Root>
										<NativeSelect.Field
											aria-label="Repeated clock hour"
											value={timing.dstDisambiguation ?? ""}
											onChange={(e) =>
												setTiming((t) => ({
													...t,
													dstDisambiguation: e.target.value as
														| "earlier"
														| "later",
												}))
											}
										>
											<option value="">Choose occurrence</option>
											<option value="earlier">First occurrence</option>
											<option value="later">Second occurrence</option>
										</NativeSelect.Field>
									</NativeSelect.Root>
								)}
								{slots.length > 0 && (
									<Collapsible.Root>
										<Collapsible.Trigger asChild>
											<Button size="xs" variant="ghost">
												View schedule ({slots.length}{" "}
												{slots.length === 1 ? "clip" : "clips"})
												<ChevronDown size={12} />
											</Button>
										</Collapsible.Trigger>
										<Collapsible.Content>
											<Stack gap="0" maxH="160px" overflowY="auto" pt="2">
												{slots.map((slot, index) => (
<Flex key={slot.clipId} gap="3" align="center" justify="space-between" py="3" borderTopWidth="1px" borderColor="border.subtle">
<Flex gap="3" align="center" minW="0"><Text fontSize="xs" color="fg.muted" minW="4">{index + 1}</Text><Text fontSize="xs" lineClamp={1}>{clips.find(c => c.id === slot.clipId)?.title}</Text></Flex>
<Text fontSize="xs" color="fg.muted" whiteSpace="nowrap">{new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",timeZone:config.workspaceTimezone}).format(new Date(slot.scheduledFor))}</Text>
</Flex>
))}
											</Stack>
										</Collapsible.Content>
									</Collapsible.Root>
								)}
							</>
						
					</Stack>
				</chakra.fieldset>)}
				{error && (
					<Text role="alert" fontSize="xs" color="danger.fg">
						{error}
					</Text>
				)}
				{!config.campaignSchedulingEnabled && pairs.length > 1 && (
					<Text fontSize="xs" color="warning.fg">
						Publishing multiple posts together requires a Pro plan.
					</Text>
				)}
				<Flex justify="space-between" gap="3" align="center">
					<chakra.fieldset disabled={disabled} border="0" p="0" m="0" flex="1" minW="0"><Flex gap="2" align="center" wrap="nowrap">
							<Button
								size="sm"
								variant={timing.scheduleMode === "now" ? "outline" : "ghost"}
								onClick={() =>
									setTiming((t) => ({ ...t, scheduleMode: "now" }))
								}
							>
								Now
							</Button>
							<Button
								size="sm"
								variant={timing.scheduleMode !== "now" ? "outline" : "ghost"}
								onClick={() =>
									setTiming((t) => ({ ...t, scheduleMode: "scheduled" }))
								}
							>
								<CalendarClock size={14} />
								Schedule
							</Button>
							<Text fontSize="xs" color="fg.muted" ms="auto" whiteSpace="nowrap">
								{config.workspaceTimezone}
							</Text>
						</Flex></chakra.fieldset>
					<Flex gap="3" align="center">
						<Text fontSize="xs" color="fg.muted">
							{directCount
								? `${directCount} post${directCount === 1 ? "" : "s"}`
								: ""}
							{directCount && inboxCount ? " · " : ""}
							{inboxCount
								? `${inboxCount} TikTok inbox ${inboxCount === 1 ? "draft" : "drafts"}`
								: ""}
						</Text>
						<Button
							size="sm"
							disabled={
								busy ||
								(!pending &&
									(!restored ||
										!unresolved.length ||
										issueCount > 0 ||
										(pairs.length > 1 && !config.campaignSchedulingEnabled) ||
										(timing.scheduleMode !== "now" &&
											(!!previewError || !slots.length)) ||
										(approvalBlocked &&
											(!config.canOverrideReview || !override.trim()))))
							}
							onClick={() => void submit()}
						>
							{busy ? <Spinner size="xs" /> : <Send size={14} />}{" "}
							{pending
								? "Check previous submission"
								: timing.scheduleMode !== "now"
									? "Schedule"
									: inboxCount && !directCount
										? "Send to TikTok"
										: inboxCount
											? "Submit selection"
											: "Publish now"}
						</Button>
					</Flex>
				</Flex>
			</Drawer.Footer>
			{coverPair && coverMedia && (
				<PublishingCover
					projectId={config.projectId}
					clipId={active.id}
					platform={coverPair.account.platform}
					variant={coverMedia.variant}
					canUpload={config.canUploadVisualAssets}
					onChoose={(value) => {
						update(coverPair.key, { thumbnail: value });
						setCoverAccount(null);
					}}
					onClose={() => setCoverAccount(null)}
				/>
			)}
		</>
	);
}
