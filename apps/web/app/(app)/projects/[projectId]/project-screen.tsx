"use client";

import Link from "next/link";
import { notFound, useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { Flex, Stack, Tabs, Text } from "@chakra-ui/react";
import { describeApiFailure, isApiError } from "@narriflow/api-client";
import { projectQueries } from "@narriflow/api-client/projects";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Bone } from "@narriflow/ui/components/page-loading";
import type { TranscriptSnapshot } from "@narriflow/validators";
import type { SessionUser } from "@narriflow/validators/api/session";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Info } from "lucide-react";
import { type ClipApi, useClipApi } from "@/lib/clip-media";
import { resolveReviewPreselection } from "@/lib/review-preselection";
import { useWorkspaceBootstrap } from "../../_components/usage";
import { AnalyticsPanel } from "./analytics-panel";
import { ContentSuitePanel } from "./content-suite-panel";
import { DubbingPanel } from "./dubbing-panel";
import { ProjectClipsTab } from "./project-clips-tab";
import { ProjectEvents } from "./project-events";
import { ProjectEventsProvider } from "./project-events-provider";
import { ProjectHeader } from "./project-header";
import { ProjectLoadError, projectAccessLost, projectGateDestination } from "./project-load-error";
import { ProjectSkeleton } from "./project-skeleton";
import { ProjectTabs, TabCountBadge } from "./project-tabs";
import { type ProjectTab, projectTabFromSearchParam } from "./project-tab";
import {
	type ProjectDetailData,
	type ProjectRecord,
	derivePlanFacts,
	deriveProjectView,
	dubbingUpgradeFor,
} from "./project-view-model";
import { ProjectPosts, PublishingProvider } from "./publishing-provider";
import { ReviewPanel, type ReviewRoomData } from "./review-panel";
import { TranscriptPanel } from "./transcript-panel";

/** Accounts are read only for the Clips and Posts tabs; every other tab hands the drawer none. */
const NO_ACCOUNTS: ProjectDetailData["tabData"]["socialAccounts"] = [];

/** The Project page: one aggregate per tab, fetched as soon as the Workspace is known. */
export function ProjectScreen() {
	const { projectId } = useParams<{ projectId: string }>();
	const api = useClipApi();
	if (!api) return <ProjectSkeleton />;
	return <ProjectData key={`${api.scope.workspaceId}:${projectId}`} api={api} projectId={projectId} />;
}

function ProjectData({ api, projectId }: { api: ClipApi; projectId: string }) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const activeTab = projectTabFromSearchParam(searchParams.get("tab"));
	const reviewSelection = searchParams.get("reviewSelection") ?? undefined;
	// Read by the app shell already; requested here too so neither waits for the other.
	const bootstrap = useWorkspaceBootstrap(api.scope);
	const detailQuery = useQuery({
		...projectQueries.detail(api.projects, api.scope, projectId, activeTab),
		// The page chrome stays up while another tab's data arrives; never another Project's.
		placeholderData: (previous) => (previous?.snapshot.project?.id === projectId ? previous : undefined),
	});

	// Cached data hides a failed re-read only while the failure is recoverable; losing access replaces the page.
	const failure =
		detailQuery.isError && (!detailQuery.data || projectAccessLost(detailQuery.error)) ? detailQuery.error : null;
	const destination = failure ? projectGateDestination(failure, projectId) : null;
	useEffect(() => {
		if (destination) router.replace(destination);
	}, [destination, router]);

	if (failure) {
		if (destination) return <ProjectSkeleton />;
		const { kind } = describeApiFailure(failure);
		// A Project that is gone, foreign or malformed is concealed the same way.
		if (kind === "missing" || kind === "validation") notFound();
		// Sign-in, Workspace re-selection and a superseded request are handled by the shell.
		if (kind === "authenticate" || kind === "reselect_workspace" || kind === "superseded") {
			return <ProjectSkeleton />;
		}
		return (
			<ProjectLoadError
				onRetry={() => void detailQuery.refetch()}
				supportId={isApiError(failure) ? failure.requestId : null}
			/>
		);
	}
	const detail = detailQuery.data;
	const user = bootstrap.data?.user;
	if (!detail || !user) return <ProjectSkeleton />;
	const project = detail.snapshot.project;
	if (!project) notFound();

	return (
		<ProjectBody
			projectId={projectId}
			workspaceId={api.scope.workspaceId}
			activeTab={activeTab}
			reviewSelection={reviewSelection}
			detail={detail}
			project={project}
			user={user}
		/>
	);
}

function ProjectBody({
	projectId,
	workspaceId,
	activeTab,
	reviewSelection,
	detail,
	project,
	user,
}: {
	projectId: string;
	workspaceId: string;
	activeTab: ProjectTab;
	reviewSelection: string | undefined;
	detail: ProjectDetailData;
	project: ProjectRecord;
	user: SessionUser;
}) {
	const { clips, access, usage } = detail;
	const pricingTier = usage.tier;
	// Tier and Workspace kind decide every prompt; keying on them keeps panel props
	// stable while the data underneath refetches.
	const plan = useMemo(
		() => derivePlanFacts(pricingTier, access.isPersonalWorkspace),
		[pricingTier, access.isPersonalWorkspace],
	);
	const view = useMemo(() => deriveProjectView(detail, project), [detail, project]);
	const sourceVideoUrl = useStableSourceUrl(detail.tabData.sourceVideo);
	const tabReady = detail.tab === activeTab;

	const { reviewRoom } = detail.tabData;
	const reviewData = useMemo(() => (reviewRoom ? (reviewRoom as unknown as ReviewRoomData) : null), [reviewRoom]);
	const reviewPreselection = useMemo(
		() => (reviewData && view.canManageReview ? resolveReviewPreselection(reviewData.candidates, reviewSelection) : null),
		[reviewData, view.canManageReview, reviewSelection],
	);
	const { dubAllowance } = detail.tabData;
	const dubbingUpgrade = useMemo(() => dubbingUpgradeFor(pricingTier, dubAllowance), [pricingTier, dubAllowance]);
	const actor = useMemo(
		() => ({ firstName: user.firstName, lastName: user.lastName, email: user.email, imageUrl: user.imageUrl }),
		[user.firstName, user.lastName, user.email, user.imageUrl],
	);

	const transcript =
		detail.transcript.view === "full" ? (detail.transcript.data as TranscriptSnapshot | null) : null;

	return (
		<Stack data-project-page gap={{ base: "4", md: "6" }} maxW="1400px" mx="auto" w="full">
			<ProjectEventsProvider
				projectId={projectId}
				initialSeq={detail.snapshot.lastSeq}
				initialEvents={detail.workflowHistory}
			>
				<Link data-project-back href="/projects" aria-label="Back to projects">
					<Flex align="center" gap="2" color="fg.muted" fontSize="xs" w="fit-content" _hover={{ color: "fg" }}>
						<ArrowLeft size={14} />
						All projects
					</Flex>
				</Link>
				<ProjectHeader
					projectId={projectId}
					project={project}
					detail={detail}
					view={view}
					plan={plan}
					actor={actor}
					processingPanelVisible={activeTab === "clips" && view.showProcessingPanel}
				/>
				{view.viewOnlyNote ? (
					<Flex
						data-project-view-only
						align={{ base: "flex-start", sm: "center" }}
						gap="3"
						wrap="wrap"
						px="4"
						py="3"
						bg="bg.soft"
						borderRadius="l3"
					>
						<Flex align="center" gap="2" flex="1" minW="0" color="fg.muted">
							<Info size={14} aria-hidden />
							<Text fontSize="sm">{view.viewOnlyNote.message}</Text>
						</Flex>
						{view.viewOnlyNote.billingAction ? (
							<Button size="sm" variant="subtle" asChild>
								<Link href="/settings/billing">{view.viewOnlyNote.billingAction}</Link>
							</Button>
						) : null}
					</Flex>
				) : null}
				{/* Workspace tabs — URL-driven (?tab=). The progress stream is shared via
				    ProjectEventsProvider so the Clips-tab processing checklist and the
				    Activity tab consume one connection. */}
				<PublishingProvider
					projectId={projectId}
					actorId={user.id}
					workspaceId={workspaceId}
					clips={clips}
					accounts={detail.tabData.socialAccounts ?? NO_ACCOUNTS}
					initialPosts={detail.socialPosts.items}
					initialPostsCursor={detail.socialPosts.nextCursor}
					workspaceTimezone={detail.tabData.workspaceTimezone ?? "UTC"}
					can1080pExport={plan.can1080pExport}
					canOverrideReview={view.canOverrideReview}
					canPublish={view.canPublish}
					publishingUpgrade={plan.publishingUpgrade}
					assistedCopyEnabled={plan.assistedCopyEnabled}
					assistedCopyUpgrade={plan.assistedCopyUpgrade}
					customThumbnailsEnabled={plan.customThumbnailsEnabled}
					customThumbnailsUpgrade={plan.customThumbnailsUpgrade}
					campaignSchedulingEnabled={plan.campaignSchedulingEnabled}
					canUploadVisualAssets={view.canUploadVisualAssets}
				>
					<ProjectTabs clipsCountBadge={<TabCountBadge count={clips.length} />}>
						<Tabs.Content value="clips" pt="6">
							{activeTab === "clips" ? (
								tabReady ? (
									<ProjectClipsTab
										projectId={projectId}
										detail={detail}
										project={project}
										view={view}
										campaign={plan.campaign}
										sourceVideoUrl={sourceVideoUrl}
										canManageBilling={access.role === "owner"}
									/>
								) : (
									<TabPending />
								)
							) : null}
						</Tabs.Content>

						<Tabs.Content value="transcript" pt="6">
							{activeTab === "transcript" ? (
								tabReady ? (
									<TranscriptPanel projectId={projectId} transcript={transcript} />
								) : (
									<TabPending />
								)
							) : null}
						</Tabs.Content>

						<Tabs.Content value="repurpose" pt="6">
							{activeTab === "repurpose" ? (
								view.transcriptReady ? (
									<ContentSuitePanel
										projectId={projectId}
										transcriptReady={view.transcriptReady}
										planRequirement={plan.contentSuiteRequirement}
										upgrade={plan.contentSuiteUpgrade}
										canEdit={view.canEdit}
									/>
								) : (
									<EmptyState
										title="Transcript required"
										description={
											view.transcriptInFlight
												? "Transcription is running. Posts and show notes can be written once it finishes."
												: "Complete transcription to generate posts and show notes."
										}
										action={
											<Button size="sm" variant="subtle" asChild>
												<Link href={`/projects/${projectId}`}>Go to clips</Link>
											</Button>
										}
									/>
								)
							) : null}
						</Tabs.Content>

						<Tabs.Content value="dubbing" pt="6">
							{activeTab === "dubbing" ? (
								tabReady ? (
									<DubbingPanel
										projectId={projectId}
										clips={clips}
										dubs={detail.tabData.dubs}
										allowance={dubAllowance}
										planRequirement={plan.dubbingRequirement}
										upgrade={dubbingUpgrade}
										canEdit={view.canEdit}
									/>
								) : (
									<TabPending />
								)
							) : null}
						</Tabs.Content>

						<Tabs.Content value="review" pt="6">
							{activeTab === "review" ? (
								tabReady ? (
									reviewData ? (
										<ReviewPanel
											projectId={projectId}
											initialData={reviewData}
											canManage={view.canManageReview}
											preselection={reviewPreselection}
										/>
									) : null
								) : (
									<TabPending />
								)
							) : null}
						</Tabs.Content>

						<Tabs.Content value="posts" pt="6">
							{activeTab === "posts" ? tabReady ? <ProjectPosts /> : <TabPending /> : null}
						</Tabs.Content>

						<Tabs.Content value="analytics" pt="6">
							{activeTab === "analytics" ? (
								tabReady ? (
									detail.tabData.analytics ? (
										<AnalyticsPanel analytics={detail.tabData.analytics} clips={clips} />
									) : null
								) : (
									<TabPending />
								)
							) : null}
						</Tabs.Content>

						{/* ACTIVITY — keep mounted regardless of active tab: the progress stream
						    (owned by ProjectEventsProvider above) feeds it for the whole page. */}
						<Tabs.Content value="activity" pt="6">
							<ProjectEvents />
						</Tabs.Content>
					</ProjectTabs>
				</PublishingProvider>
			</ProjectEventsProvider>
		</Stack>
	);
}

/** Stands in for the active tab while its data loads; the chrome around it stays. */
function TabPending() {
	return (
		<Stack gap="4" aria-busy="true" aria-label="Loading">
			<Bone h="8" w="min(320px, 60%)" borderRadius="l2" />
			<Bone h="40" w="full" borderRadius="l3" />
			<Bone h="40" w="full" borderRadius="l3" />
		</Stack>
	);
}

/** Playback URLs are re-signed on every read; keep the held one while it has plenty of life left. */
const SOURCE_URL_REFRESH_MARGIN_MS = 10 * 60_000;

function useStableSourceUrl(grant: { url: string; expiresAt: string } | null): string | null {
	const held = useRef(grant);
	if (!grant) {
		held.current = null;
	} else if (
		!held.current ||
		held.current.url === grant.url ||
		Date.parse(held.current.expiresAt) - Date.now() < SOURCE_URL_REFRESH_MARGIN_MS
	) {
		held.current = grant;
	}
	return held.current?.url ?? null;
}
