"use client";
import dynamic from "next/dynamic";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CloseButton, Drawer, Flex, Portal, Stack, Text } from "@chakra-ui/react";
import { Send } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
	socialPostSnapshotSchema,
	type BulkSocialScheduleOutcome,
	type ClipSnapshot,
	type SocialAccountSnapshot,
	type SocialPostSnapshot,
} from "@narriflow/validators";
import { isLiveSocialPostSnapshot } from "@/lib/social-post-status";
import { browserPublishingStorage } from "./publishing-draft";
import { createProjectPublishingApi, type ProjectPublishingApi } from "./publishing-api";
import { createPublishingCompositionSession } from "./publishing-composition-session";
import { PanelHeader } from "./panel-header";
import { scopedKey } from "@narriflow/api-client";
import { useQuery } from "@tanstack/react-query";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { useUpgrade, type UpgradePrompt } from "../../_components/upgrade";

export type Config = {
	projectId: string;
	actorId: string;
	workspaceId: string;
	workspaceTimezone: string;
	clips: ClipSnapshot[];
	accounts: SocialAccountSnapshot[];
	initialPosts: SocialPostSnapshot[];
	initialPostsCursor: string | null;
	assistedCopyEnabled: boolean;
	/** What unlocks assisted copy; `null` when the plan already has it. */
	assistedCopyUpgrade: UpgradePrompt | null;
	customThumbnailsEnabled: boolean;
	/** What unlocks custom thumbnails; `null` when the plan already has it. */
	customThumbnailsUpgrade: UpgradePrompt | null;
	campaignSchedulingEnabled: boolean;
	canUploadVisualAssets: boolean;
	can1080pExport: boolean;
	canOverrideReview: boolean;
	/** Role and workspace status allow publishing (`publishing.manage`). */
	canPublish: boolean;
	/** What unlocks publishing; `null` when the plan already publishes. */
	publishingUpgrade: UpgradePrompt | null;
};
// The posts list and the composer open on demand; their code is fetched then.
function PublishingPending() {
	return (
		<Flex flex="1" justify="center" align="center" py="10" role="status" aria-label="Loading">
			<Spinner size="sm" />
		</Flex>
	);
}
const PublishingPosts = dynamic(() => import("./publishing-posts").then((m) => m.PublishingPosts), { loading: PublishingPending });
const PublishingComposer = dynamic(() => import("./publishing-composer").then((m) => m.PublishingComposer), { loading: PublishingPending });
const PublishingRecoveryComposer = dynamic(() => import("./publishing-composer").then((m) => m.PublishingRecoveryComposer), { loading: PublishingPending });
type BulkResult = BulkSocialScheduleOutcome;
type PublishingContextValue = {
	posts: SocialPostSnapshot[];
	compose(ids: string[], exportId?: string): void;
	viewPosts(ids: string[]): void;
	refresh(): Promise<void>;
	loadOlderPosts(): Promise<void>;
	nextPostsCursor: string | null;
	config: Config;
	api: ProjectPublishingApi;
};

export function mergeRefreshedPosts(
	current: SocialPostSnapshot[],
	refreshed: SocialPostSnapshot[],
) {
	const merged = new Map(current.map((post) => [post.id, post]));
	for (const post of refreshed) merged.set(post.id, post);
	return [...merged.values()];
}

export function nextTrackedPostBatch(ids: string[], offset: number) {
	if (offset < 0) return { ids: [], nextOffset: 0 };
	const batch = ids.slice(offset, offset + 100);
	return {
		ids: batch,
		nextOffset: offset + 100 >= ids.length ? -1 : offset + 100,
	};
}
const PublishingContext = createContext<PublishingContextValue | null>(null);
export function usePublishing() {
	const context = useContext(PublishingContext);
	if (!context) throw new Error("Publishing requires its project provider");
	return context;
}
export function ProjectPosts() {
	const c = usePublishing();
	return (
		<Stack gap="6">
			<PanelHeader
				icon={<Send size={20} />}
				title="Posts"
				description="Every post from this project's clips, and where it stands."
			/>
			<PublishingPosts
				api={c.api}
				projectId={c.config.projectId}
				timeZone={c.config.workspaceTimezone}
				posts={c.posts}
				clips={c.config.clips}
				refresh={c.refresh}
				loadOlderPosts={c.loadOlderPosts}
				nextCursor={c.nextPostsCursor}
				compose={c.compose}
				canManage={c.config.canPublish}
				filterable
			/>
		</Stack>
	);
}
export function PublishingProvider({
	children,
	...config
}: Config & { children: ReactNode }) {
	const session = useMemo(() => createPublishingCompositionSession({
		scope: { actorId: config.actorId, workspaceId: config.workspaceId, projectId: config.projectId },
		storage: browserPublishingStorage,
		createId: () => crypto.randomUUID(),
		now: () => new Date(),
	}), [config.actorId, config.workspaceId, config.projectId]);
	const composition = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	useEffect(() => session.reconcile({ clips: config.clips, accounts: config.accounts, workspaceTimezone: config.workspaceTimezone }), [session, config.clips, config.accounts, config.workspaceTimezone]);
	const triggerRef = useRef<HTMLElement | null>(null);
	const [posts, setPosts] = useState(config.initialPosts);
	const [nextPostsCursor, setNextPostsCursor] = useState(config.initialPostsCursor);
	const trackedRefreshOffset = useRef(0);
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<"compose" | "posts">("compose");
	const [ids, setIds] = useState<string[]>([]);
	const [exportId, setExportId] = useState<string>();
	const [statusError, setStatusError] = useState("");
	const [submission, setSubmission] = useState<BulkResult | null>(null);
	const router = useRouter();
	const params = useSearchParams();
	const runtime = useApiRuntime();
	const scope = useWorkspaceScope();
	if (!scope) throw new Error("Publishing requires a selected Workspace");
	const api = useMemo(() => createProjectPublishingApi(runtime.transport, scope, runtime.queryClient), [runtime.transport, scope, runtime.queryClient]);
	useEffect(() => setPosts(config.initialPosts), [config.initialPosts]);
	useEffect(() => setNextPostsCursor(config.initialPostsCursor), [config.initialPostsCursor]);
	// Live posts are re-read every 5s while any is in flight, every 30s otherwise,
	// only while the tab is visible and again when it regains focus. Each answer is
	// merged into the list; one batch of at most 100 tracked ids per read.
	const postsRef = useRef(posts);
	postsRef.current = posts;
	const hasLivePosts = posts.some(isLiveSocialPostSnapshot);
	const postPoll = useQuery({
		queryKey: scopedKey(scope, "publishing", "project-posts-poll", config.projectId) as unknown[],
		queryFn: async () => {
			const live = postsRef.current.filter(isLiveSocialPostSnapshot).map((post) => post.id);
			const batch = nextTrackedPostBatch(live, trackedRefreshOffset.current);
			trackedRefreshOffset.current = batch.nextOffset;
			const result = await api.activePosts(config.projectId, batch.ids);
			return socialPostSnapshotSchema.array().parse(result.posts);
		},
		staleTime: 0,
		retry: false,
		refetchInterval: hasLivePosts ? 5000 : 30000,
		refetchOnWindowFocus: true,
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: dataUpdatedAt re-merges an unchanged answer into a list another effect reset.
	useEffect(() => {
		if (!postPoll.data) return;
		const polled = postPoll.data;
		setPosts((current) => mergeRefreshedPosts(current, polled));
		setStatusError("");
	}, [postPoll.data, postPoll.dataUpdatedAt]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: errorUpdatedAt re-shows the message after each failed read.
	useEffect(() => {
		if (postPoll.error) setStatusError("Post status could not be refreshed. Try Refresh.");
	}, [postPoll.error, postPoll.errorUpdatedAt]);
	const refetchPosts = postPoll.refetch;
	const refresh = useCallback(async () => {
		await refetchPosts({ throwOnError: true });
	}, [refetchPosts]);
	const loadOlderPosts = useCallback(async () => {
		if (!nextPostsCursor) return;
		const result = await api.olderPosts(config.projectId, nextPostsCursor);
		const older = socialPostSnapshotSchema.array().parse(result.posts);
		setPosts((current) => [...current, ...older.filter((post) => !current.some((existing) => existing.id === post.id))]);
		setNextPostsCursor(result.nextCursor);
	}, [api, config.projectId, nextPostsCursor]);
	const { openUpgrade } = useUpgrade();
	const compose = useCallback(
		(next: string[], preferred?: string) => {
			if (!config.canPublish) return;
			// Every way in (row, selection, deep link, schedule again) explains the plan first.
			if (config.publishingUpgrade) {
				openUpgrade(config.publishingUpgrade);
				return;
			}
			triggerRef.current =
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: null;
			session.open(next, { clips: config.clips, accounts: config.accounts, workspaceTimezone: config.workspaceTimezone });
			setIds(session.getSnapshot().clipIds);
			setExportId(preferred);
			setMode("compose");
			setOpen(true);
		},
		[
			config.clips,
			config.canPublish,
			config.publishingUpgrade,
			openUpgrade,
			session,
			config.accounts,
			config.workspaceTimezone,
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
	const onSubmitted = async (outcome: BulkResult) => {
		setSubmission(outcome);
		setIds(session.getSnapshot().clipIds);
		setMode("posts");
		await refresh().catch(() => setStatusError("Posts could not be refreshed. Your submission has been saved."));
	};
	const selected = (mode === "compose" ? composition.clipIds : ids).flatMap((id) => {
		const clip = config.clips.find((c) => c.id === id);
		return clip ? [clip] : [];
	});
	return (
		<PublishingContext.Provider
			value={{ posts, compose, viewPosts, refresh, loadOlderPosts, nextPostsCursor, config, api }}
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
							bg="bg.sidebar"
							display="flex"
							flexDirection="column"
						>
							<Drawer.Header
								px={{ base: "4", md: "6" }}
								py="4"
								flexShrink={0}
							>
								<Stack gap="0.5">
									<Drawer.Title fontSize="18px" fontWeight="500">
										{mode === "compose" ? "Publish" : "Posts"}
									</Drawer.Title>
									<Text color="fg.muted" fontSize="13px">
										{selected.length === 1
											? (selected[0]?.title ?? selected[0]?.hookText)
											: `${selected.length} clips selected`}
									</Text>
								</Stack>
							</Drawer.Header>
							<Drawer.CloseTrigger asChild>
								<CloseButton size="sm" borderRadius="full" aria-label="Close publishing drawer" />
							</Drawer.CloseTrigger>
							{mode === "compose" && selected.length > 0 && !composition.recoveryUnavailable ? (
								<PublishingComposer
									api={api}
									config={config}
									session={session}
									clips={selected}
									preferredExportId={exportId}
									open={open}
									onSubmitted={onSubmitted}
								/>
							) : mode === "compose" && (composition.pending || composition.recoveryUnavailable) ? (
								<PublishingRecoveryComposer api={api} session={session} onSubmitted={onSubmitted} projectId={config.projectId} />
							) : (
								<Drawer.Body p={{ base: "4", md: "6" }} mx={{ base: "0", md: "2" }} mb={{ base: "0", md: "2" }} overflowY="auto" bg="bg" borderRadius={{ base: "0", md: "12px" }}>
								{submission?.items.some(
										(item) => item.status !== "succeeded",
									) && (
										<Stack
											mb="4"
											p="3"
											bg="bg.soft"
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
												variant="subtle"
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
										api={api}
										timeZone={config.workspaceTimezone}
										projectId={config.projectId}
										posts={posts.filter(
											(p) => p.clipId && ids.includes(p.clipId),
										)}
										clips={config.clips}
										refresh={refresh}
										loadOlderPosts={loadOlderPosts}
										nextCursor={nextPostsCursor}
										compose={compose}
										canManage={config.canPublish}
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
