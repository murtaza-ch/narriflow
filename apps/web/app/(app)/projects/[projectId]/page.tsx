import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@narriflow/ui/components/button";
import { Select } from "@narriflow/ui/components/select";
import { ActionSubmitButton } from "@narriflow/ui/components/action-submit-button";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { admitProjectPage } from "@/lib/authenticated-request-page";
import {
	analyticsService,
	brandPlanRequirement,
	brandProfileService,
	clipService,

	dubbingService,
	getProcessingUsage,
	getProjectFinishing,
	hasFeature,

	isQuotaBlockedMidFlight,
	MAX_INGEST_RETRY_ATTEMPTS,
	presignDownloadUrl,
	projectService,
	reviewService,
	socialOAuthService,
	socialService,
	workspaceService,
} from "@narriflow/services";
import {
	deriveProjectPipeline,
	BRAND_DEFAULT_CAPTION_PRESET_ID,
	captionPresetIdSchema,
	creditsForSourceSeconds,
	defaultAspectRatioSchema,
	lowestTierWithFeature,
	planDefinition,
	planFeatureRequirement,
	planUpgradeHighlight,
	userErrorMessage,
	workspaceAllowsCapability,
} from "@narriflow/validators";
import { projectViewOnlyNote } from "./project-access";
import { FinishingStatus } from "./finishing-status";
import { ProjectEvents } from "./project-events";
import { SourceIcon } from "./source-icon";
import { ProjectEventsProvider } from "./project-events-provider";
import { PipelineStepper } from "./pipeline-stepper";
import { ingestRecoveryAction, ingestRecoveryLabel } from "@/lib/project-state";
import {
	creditsUpgradePrompt,
	uploadLengthUpgradePrompt,
} from "@/lib/authenticated-request-browser";
import { dubAllowanceUpgradePrompt, featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { ProjectTabs, TabCountBadge } from "./project-tabs";
import { projectTabFromSearchParam } from "./project-tab";
import { ProcessingPanel } from "./processing-panel";
import {
	applyProjectBrandProfileFormAction,
	queueTranscriptionFormAction,
	regenerateClipsFormAction,
} from "../actions";
import { AuthenticatedActionForm } from "@/app/_components/authenticated-action-form";
import { DeleteProjectButton } from "../_components/delete-project-button";
import { ProjectExpiration } from "../_components/project-expiration";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { LockedButton, UpgradeBanner, type UpgradePrompt } from "../../_components/upgrade";
import { TranscriptPanel } from "./transcript-panel";
import { ClipsPanel } from "./clips-panel";
import { deriveCampaignActionPlan } from "./campaign-command-state";
import { ContentSuitePanel } from "./content-suite-panel";
import { AnalyticsPanel } from "./analytics-panel";
import { DubbingPanel } from "./dubbing-panel";
import { ReviewPanel, type ReviewRoomData } from "./review-panel";
import { resolveReviewPreselection } from "@/lib/review-preselection";
import { ProjectShareButton } from "./project-share-button";
import { PublishingProvider, ProjectPosts } from "./publishing-provider";
import { RetryIngestButton } from "./render-clips-button";
import { AdvancedClipSettings } from "./advanced-clip-settings";
import { extractYoutubeId, youtubeThumbnailUrl } from "../_lib/youtube";
import { gradientForId } from "../_lib/gradient";
import { formatDate, formatDuration } from "@/lib/format";
import { getDisplayName, getInitials } from "@/lib/account-display";
import {
	type PipelineStepView,
} from "@/lib/project-state";
import { Stack, Box, Text, Flex, Tabs, Collapsible } from "@chakra-ui/react";
import {
	AlertTriangle,
	ArrowLeft,
	ChevronDown,
	Film,
	Info,
	Link2,
} from "lucide-react";

function SourceThumb({
	projectId,
	title,
	sourceType,
	sourceInput,
	sourceMediaUrl,
}: {
	projectId: string;
	title: string;
	sourceType: string;
	sourceInput: string | null;
	sourceMediaUrl: string;
}) {
	const youtubeId =
		sourceType === "youtube"
			? extractYoutubeId(sourceInput, sourceMediaUrl)
			: null;

	if (youtubeId) {
		return (
			<Image
				src={youtubeThumbnailUrl(youtubeId, "hq")}
				alt={title}
				fill
				sizes="256px"
				loading="eager"
				style={{ objectFit: "cover" }}
			/>
		);
	}

	const gradient = gradientForId(projectId);
	return (
		<Flex
			w="full"
			h="full"
			align="center"
			justify="center"
			style={{
				background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
			}}
		>
			<Box color="whiteAlpha.700">
				{sourceType === "link" ? (
					<Link2 size={20} aria-hidden />
				) : (
					<Film size={20} aria-hidden />
				)}
			</Box>
		</Flex>
	);
}

// PlanLimitNotice moved to app/(app)/_components/plan-limit-notice.tsx so the
// upload pre-flight can reuse it.

export default async function ProjectDetailPage({
	params,
	searchParams,
}: {
	params: Promise<{ projectId: string }>;
	searchParams: Promise<{ tab?: string; reviewSelection?: string }>;
}) {
	const [{ projectId }, query] = await Promise.all([params, searchParams]);
	const activeTab = projectTabFromSearchParam(query.tab);
	const appUser = await admitProjectPage(projectId, "content.view");
	const brandScope = {
		actorUserId: appUser.actorUserId,
		workspaceId: appUser.workspaceId,
		workspaceOwnerUserId: appUser.workspaceOwnerUserId,
		role: appUser.role,
		status: appUser.status,
		pricingTier: appUser.pricingTier,
		isPersonalWorkspace: appUser.isPersonalWorkspace,
	};
	const canManageReview = workspaceAllowsCapability(
		{ role: appUser.role, status: appUser.status },
		"review.manage",
	);
	const canOverrideReview = workspaceAllowsCapability(
		{ role: appUser.role, status: appUser.status },
		"review.override",
	);
	const snapshot = await projectService.getProjectSnapshot(appUser, projectId);

	if (!snapshot.project) {
		notFound();
	}

	const [
		fullTranscript,
		transcriptStatus,
		clips,
		latestContentPack,
		analytics,
		socialPosts,
		socialAccounts,
		dubs,
		workflowHistory,
		usage,
		brandProfiles,
		reviewRoom,
		activeWorkspace,
		finishing,
		dubAllowance,
		projectCreditUsage,
	] = await Promise.all([
		activeTab === "transcript"
			? projectService.getTranscriptSnapshot(appUser, projectId)
			: Promise.resolve(null),
		activeTab === "transcript"
			? Promise.resolve(null)
			: projectService.getTranscriptStatusSnapshot(appUser, projectId),
		clipService.listClips(appUser, projectId),
		projectService.getLatestContentPack(appUser, projectId),
		activeTab === "analytics"
			? analyticsService.getProjectAnalytics(appUser, projectId)
			: Promise.resolve(null),
		socialService.listProjectPosts(appUser, projectId),
		activeTab === "posts" || activeTab === "clips"
			? socialOAuthService.listAccounts(appUser)
			: Promise.resolve([]),
		activeTab === "dubbing"
			? dubbingService.listProjectDubs(appUser, projectId)
			: Promise.resolve([]),
		projectService.getWorkflowHistory(appUser, projectId),
		projectService.getUsageSummary(appUser),
		activeTab === "clips"
			? brandProfileService.list(brandScope)
			: Promise.resolve([]),
		activeTab === "review"
			? reviewService.internalRoom(
					appUser.workspaceId,
					projectId,
					canManageReview ? "manage" : "view",
				)
			: Promise.resolve(null),
		activeTab === "posts" || activeTab === "clips"
			? workspaceService.getWorkspace(appUser.actorUserId, appUser.workspaceId)
			: Promise.resolve(null),
		getProjectFinishing({ workspaceId: appUser.workspaceId, projectId }),
		activeTab === "dubbing"
			? dubbingService.getDubbingAllowance(appUser)
			: Promise.resolve(null),
		// The period settlement checks, excluding this Project's own reservation.
		getProcessingUsage().projectCreditUsage(projectId),
	]);
	const reviewRoomData = reviewRoom
		? (JSON.parse(JSON.stringify(reviewRoom)) as ReviewRoomData)
		: null;
	const reviewPreselection =
		reviewRoomData && canManageReview
			? resolveReviewPreselection(reviewRoomData.candidates, query.reviewSelection)
			: null;
	const transcript = fullTranscript ?? transcriptStatus;
	const pricingTier = usage.tier;
	// vizard-parity Phase C export options: whether this owner's plan can
	// render at 1080p, via the shared entitlement helper — never a raw
	// `pricingTier === "free"` check — so the render popover's resolution
	// picker degrades exactly the way the worker's render-time gate does.
	const can1080pExport = hasFeature(pricingTier, "export.1080p");
	// Every project mutation needs `content.edit` (or a capability granted with
	// it); without it the page explains why once and leaves out the controls.
	const access = { role: appUser.role, status: appUser.status };
	const canEdit = workspaceAllowsCapability(access, "content.edit");
	const viewOnlyNote = projectViewOnlyNote(access);
	// The same rule the service applies when branding is applied: in a shared
	// Workspace it also needs the plan with team members.
	const brandRequirement = brandPlanRequirement(
		{ pricingTier, isPersonalWorkspace: appUser.isPersonalWorkspace },
		"brand.profiles",
	);
	const brandApplyUpgrade: UpgradePrompt | null = brandRequirement?.requiredTier
		? {
				tier: brandRequirement.requiredTier,
				headline: "Upgrade to brand your clips",
				highlight: planUpgradeHighlight(brandRequirement.requiredTier, "brand.profiles"),
			}
		: null;
	const publishingUpgrade = featureUpgradePrompt(
		pricingTier,
		"publishing.schedule",
		"Upgrade to publish your clips",
	);
	const { availability: campaignActionAvailability, upgradePrompts: campaignUpgradePrompts } =
		deriveCampaignActionPlan({ pricingTier, brandRequirement });
	const contentSuiteUpgrade = featureUpgradePrompt(
		pricingTier,
		"content.repurposing",
		"Upgrade to repurpose your videos",
	);
	// The offer must admit the next dub: a plan with dubbing *and* room after
	// this month's dubs (a downgrade keeps them), or none. Without usage facts,
	// fall back to the plan that dubs at all.
	const dubAllowanceUpgrade = dubAllowance ? dubAllowanceUpgradePrompt(pricingTier, dubAllowance.used) : null;
	const dubbingUpgrade = !hasFeature(pricingTier, "dubbing")
		? dubAllowance
			? dubAllowanceUpgrade && { ...dubAllowanceUpgrade, headline: "Upgrade to dub your clips" }
			: featureUpgradePrompt(pricingTier, "dubbing", "Upgrade to dub your clips")
		: dubAllowance && dubAllowance.remaining <= 0
			? dubAllowanceUpgrade
			: null;
	const canApplyBrandProfile = canEdit && brandRequirement === null;

	const isIngestReady = snapshot.project.ingestStatus === "ready";
	const isIngestFailed = snapshot.project.ingestStatus === "failed";
	const ingestAttemptsExhausted =
		snapshot.ingestAttemptCount >= MAX_INGEST_RETRY_ATTEMPTS;
	// A Google Drive Picker import can't be retried: its token ended with its job.
	const ingestFromDrivePicker = snapshot.ingestJobType === "drive_import";
	const ingestRetryLimitMessage = `Retry limit reached (${snapshot.ingestAttemptCount}/${MAX_INGEST_RETRY_ATTEMPTS}). This source keeps failing to import.`;
	// Ingest only ever reaches "ready" once sourceStorageKey is set, so a null
	// key here means the source was reclaimed after retention (see
	// purgeExpiredProjectSources), not a broken upload.
	const isSourceExpired = isIngestReady && !snapshot.project.sourceStorageKey;
	// Playable source URL for the Trim/Extend dialog's preview pane (same
	// presign the studio uses). Null once the source is purged — the dialog
	// hides the player pane rather than breaking.
	let sourceVideoUrl: string | null = null;
	if (activeTab === "clips" && snapshot.project.sourceStorageKey) {
		try {
			sourceVideoUrl = await presignDownloadUrl({
				key: snapshot.project.sourceStorageKey,
				expiresIn: 3600,
			});
		} catch {
			// Non-fatal — the dialog degrades to transcript-only.
		}
	}
	// The per-video cap is deterministic, so show it before the click. Credits
	// are decided by Processing Usage settlement; a refusal is persisted on the
	// Project and rendered from its typed code. Regeneration is free. Once the
	// Project is settled (or refunded), settlement returns early, so a retry
	// skips the length and credit checks and no block or offer applies.
	const sourceSeconds = snapshot.project.sourceDurationSeconds ?? 0;
	const settlementFinal =
		projectCreditUsage?.state === "settled" || projectCreditUsage?.state === "refunded";
	const planLimitMessage =
		!settlementFinal && sourceSeconds > usage.maxUploadSeconds
			? `This source is ${Math.ceil(sourceSeconds / 60)} min, over the ${Math.round(
					usage.maxUploadSeconds / 60,
				)}-min per-video limit on the ${planDefinition(pricingTier).name} plan.`
			: null;
	const transcriptReady = transcript?.status === "completed";
	const transcriptInFlight =
		transcript?.status === "queued" || transcript?.status === "processing";
	const captionPresetParsed = captionPresetIdSchema.safeParse(
		latestContentPack?.captionPreset,
	);
	const defaultCaptionPreset = captionPresetParsed.success
		? captionPresetParsed.data
		: BRAND_DEFAULT_CAPTION_PRESET_ID;
	// Raw Prisma column, not the zod-narrowed union — parse it the same way
	// defaultCaptionPreset does above, rather than casting.
	const defaultAspectRatioParsed = defaultAspectRatioSchema.safeParse(
		latestContentPack?.defaultAspectRatio,
	);
	const clipsDefaultAspectRatio = defaultAspectRatioParsed.success
		? defaultAspectRatioParsed.data
		: "9:16";
	const advancedSettingsProps = {
		sourceDurationSec: snapshot.project.sourceDurationSeconds,
		defaultProcessingStartSec: latestContentPack?.processingStartSec ?? null,
		defaultProcessingEndSec: latestContentPack?.processingEndSec ?? null,
		defaultCaptionPreset,
	};

	// Pipeline derivation from existing workflow/status data.
	const activeRun = snapshot.activeRun;
	const renderVariants = clips.flatMap((clip) => clip.renderVariants);
	const pipelineStates = deriveProjectPipeline({
		ingestStatus: snapshot.project.ingestStatus,
		transcript,
		clipCount: clips.length,
		latestRun: activeRun,
		renderVariants,
		socialPosts: socialPosts.items,
	});
	const detectionInFlight = pipelineStates.detect === "active";
	const hasRenderableClips = clips.length > 0;

	// Link-first split (Phase 0/1): the latest pack may still be a draft — a
	// draft must never be treated as an active configuration (never read its
	// mode as if generation could be running against it).
	const isDraftPack = latestContentPack?.draft === true;
	const hasCommittedPack = latestContentPack !== null && !isDraftPack;
	const generationMode: "clip" | "caption_only" =
		latestContentPack?.mode === "caption_only" ? "caption_only" : "clip";

	const ingestInProgress = !isIngestReady && !isIngestFailed;
	const runInFlight =
		activeRun !== null &&
		(activeRun.status === "queued" ||
			activeRun.status === "running" ||
			activeRun.status === "waiting");
	const runFailed = activeRun !== null && activeRun.status === "failed";
	const quotaBlockedMidFlight = isQuotaBlockedMidFlight({
		ingestErrorCode: snapshot.project.ingestErrorCode,
	});
	// Cover this source once in the period its next attempt checks. An older
	// live reservation still settles in its admission month. Without a known
	// duration or ledger facts no specific plan can be promised.
	const sourceCredits =
		sourceSeconds > 0 && projectCreditUsage && !settlementFinal
			? {
					spentCredits: projectCreditUsage.spentCredits,
					requestedCredits: creditsForSourceSeconds(sourceSeconds),
				}
			: null;
	// A plan only helps when one qualifies; at the top the notice just explains.
	const quotaUpgrade =
		!quotaBlockedMidFlight || !sourceCredits
			? null
			: snapshot.project.ingestErrorCode === "upload_too_long"
				? uploadLengthUpgradePrompt(pricingTier, sourceSeconds, sourceCredits)
				: creditsUpgradePrompt(pricingTier, sourceCredits.spentCredits, sourceCredits.requestedCredits);
	// Length never recovers on renewal: an overlong source needs a qualifying
	// plan or a shorter replacement. Only spent credits wait for the renewal.
	const quotaBlockedMessage = quotaBlockedMidFlight
		? snapshot.project.ingestErrorCode === "upload_too_long"
			? `This source is longer than the ${Math.round(
					usage.maxUploadSeconds / 60,
				)}-min per-video limit on ${planDefinition(usage.tier).name}. ${
					quotaUpgrade
						? "Upgrade to a plan that fits it, or replace it with a shorter source."
						: sourceCredits
							? "No plan fits it, so replace it with a shorter source."
							: "Replace it with a shorter source, or check Billing for plans that allow longer videos."
				}`
			: `${usage.remainingCredits} of ${usage.limitCredits} ${planDefinition(usage.tier).name} credits remain this month, with a ${Math.round(
					usage.maxUploadSeconds / 60,
				)}-min per-video limit. Retry ${quotaUpgrade ? "after upgrading or " : ""}when credits renew on ${usage.renewsAt.toISOString().slice(0, 10)} (UTC).`
		: null;

	const { transcribe: transcribeStage, detect: detectStage, render: renderStage } = pipelineStates.processingStages;

	// Phase 2a — the Clips tab shows the processing panel instead of the
	// Step 01/02 form cards whenever a run is in flight, or ingest is still
	// running/failed with a committed pack, or quota was crossed mid-flight.
	//
	// Keep processing visible until rendering succeeds.
	const renderStageSucceeded =
		renderStage.status === "completed" || renderStage.status === "partial";
	const showProcessingPanel =
		hasCommittedPack &&
		(clips.length === 0
			? ingestInProgress ||
				isIngestFailed ||
				runInFlight ||
				runFailed ||
				quotaBlockedMidFlight
			: pipelineStates.hasUnfinishedProcessing || !renderStageSucceeded);

	const steps: PipelineStepView[] = [
		{
			label: "Ingest",
			state: pipelineStates.ingest,
			status: snapshot.project.ingestStatus,
		},
		{
			label: "Transcribe",
			state: pipelineStates.transcribe,
			status: transcribeStage.status,
		},
		{
			label: "Detect",
			state: pipelineStates.detect,
			status: detectStage.status,
		},
		{
			label: "Render",
			state: pipelineStates.render,
			status: renderStage.status,
		},
		{
			label: "Publish",
			state: pipelineStates.publish,
		},
	];

	const durationSec = snapshot.project.sourceDurationSeconds;

	const projectProgress = snapshot.progress;

	return (
		<Stack
			data-project-page
			gap={{ base: "4", md: "6" }}
			maxW="1400px"
			mx="auto"
			w="full"
		>
			<ProjectEventsProvider
				projectId={projectId}
				initialSeq={snapshot.lastSeq}
				initialEvents={workflowHistory}
			>
				<Link data-project-back href="/projects" aria-label="Back to projects">
					<Flex
						align="center"
						gap="2"
						color="fg.muted"
						fontSize="xs"
						w="fit-content"
						_hover={{ color: "fg" }}
					>
						<ArrowLeft size={14} />
						All projects
					</Flex>
				</Link>
				<Collapsible.Root
					defaultOpen={
						clips.length === 0 ||
						ingestInProgress ||
						runInFlight ||
						runFailed ||
						Boolean(snapshot.project.ingestErrorCode) ||
						activeRun?.status === "partial"
					}
				>
					<Flex
						data-project-heading
						align="flex-start"
						gap="4"
						direction={{ base: "column", md: "row" }}
						animation="fade-up"
					>
						<Stack gap="3" flex="1" minW="0">
							<Text
								as="h1"
								textStyle="title"
								fontSize={{ base: "xl", md: "24px" }}
								color="fg"
								lineClamp={2}
							>
								{snapshot.project.title}
							</Text>
							<Flex align="center" gap="3" wrap="wrap">
								<SourceIcon
									sourceType={snapshot.project.sourceType}
									sourceProvider={snapshot.project.sourceProvider}
								/>
								{typeof durationSec === "number" && durationSec > 0 && (
									<Text fontSize="xs" color="fg.subtle">
										{formatDuration(durationSec)}
									</Text>
								)}
								<Text fontSize="xs" color="fg.subtle">
									{formatDate(snapshot.project.createdAt)}
								</Text>
								{snapshot.project.expiresAt ? (
									<ProjectExpiration expiresAt={snapshot.project.expiresAt} />
								) : null}
								{(projectProgress.active || projectProgress.status === "failed") && (
									<StatusBadge
										status={projectProgress.status}
										label={projectProgress.label}
									/>
								)}
							</Flex>
						</Stack>
						<Flex gap="2" align="center" flexShrink={0} wrap="wrap">
							<Collapsible.Trigger asChild>
								<Button variant="subtle" size="sm">
									Project details{" "}
									<Collapsible.Indicator>
										<ChevronDown size={16} />
									</Collapsible.Indicator>
								</Button>
							</Collapsible.Trigger>
							{canManageReview ? (
								<ProjectShareButton
									projectId={projectId}
									upgrade={featureUpgradePrompt(pricingTier, "review.rooms", "Upgrade to share projects for client review")}
									actor={{
										name: getDisplayName(appUser.firstName, appUser.lastName),
										email: appUser.primaryEmail,
										imageUrl: appUser.imageUrl,
										initials: getInitials(
											appUser.firstName,
											appUser.lastName,
											appUser.primaryEmail,
										),
										role: appUser.role,
									}}
								/>
							) : null}
							{canEdit ? (
								<DeleteProjectButton
									projectId={projectId}
									projectTitle={snapshot.project.title}
									variant="menu"
								/>
							) : null}
						</Flex>
					</Flex>

					<Collapsible.Content pt="5">
						<Flex
							gap="5"
							align={{ base: "stretch", md: "center" }}
							direction={{ base: "column", md: "row" }}
							animation="fade-up"
							animationFillMode="backwards"
							style={{ animationDelay: "120ms" }}
						>
							<MediaWell
								ratio={16 / 9}
								w={{ base: "full", md: "232px" }}
								flexShrink={0}
								timecode={
									typeof durationSec === "number" && durationSec > 0
										? formatDuration(durationSec)
										: undefined
								}
							>
								<SourceThumb
									projectId={projectId}
									title={snapshot.project.title}
									sourceType={snapshot.project.sourceType}
									sourceInput={snapshot.project.sourceInput}
									sourceMediaUrl={snapshot.project.sourceMediaUrl}
								/>
							</MediaWell>

							<Stack flex="1" minW="0" gap="3">
								<PipelineStepper
									steps={steps}
									workflowRunId={activeRun?.workflowRunId ?? null}
								/>
								{isSourceExpired && (
									<Flex align="center" gap="2" color="fg.muted">
										<Info size={13} aria-hidden />
										<Text fontSize="xs">
											The original source was cleared after retention to save
											storage. Existing clips and renders are unaffected.
										</Text>
									</Flex>
								)}
								{activeRun?.status === "partial" && (
									<Flex align="center" gap="2" color="warning.fg">
										<AlertTriangle size={14} aria-hidden />
										<Text fontSize="sm">
											Some outputs failed, but successful clips remain ready to
											use. Retry only the failed outputs from their rows.
										</Text>
									</Flex>
								)}
								{finishing && (
									<FinishingStatus
										projectId={projectId}
										finishing={finishing}
									/>
								)}
								{snapshot.project.ingestErrorCode && (
									<Stack gap="2">
										<Flex align="center" gap="2" color="danger.fg">
											<AlertTriangle size={14} aria-hidden />
											<Text fontSize="sm">
												{userErrorMessage(snapshot.project.ingestErrorCode)}
											</Text>
										</Flex>
										{canEdit && isIngestFailed &&
											ingestRecoveryAction(
												snapshot.project.ingestErrorCode,
												ingestFromDrivePicker,
											) === "retry" && (
												<RetryIngestButton
													projectId={projectId}
													disabled={ingestAttemptsExhausted}
													limitReachedMessage={`Retry limit reached (${snapshot.ingestAttemptCount}/${MAX_INGEST_RETRY_ATTEMPTS}). This source keeps failing to import.`}
												/>
											)}
										{canEdit && isIngestFailed &&
											ingestRecoveryAction(
												snapshot.project.ingestErrorCode,
												ingestFromDrivePicker,
											) === "new_upload" && (
												<Button
													size="sm"
													variant="subtle"
													asChild
													alignSelf="flex-start"
												>
													<Link href="/upload">
														{ingestRecoveryLabel(ingestFromDrivePicker)}
													</Link>
												</Button>
											)}
									</Stack>
								)}
							</Stack>
						</Flex>

						{brandProfiles.length > 0 ? (
							<Box mt="5">
								<AuthenticatedActionForm
									action={applyProjectBrandProfileFormAction}
								>
									<input type="hidden" name="projectId" value={projectId} />
									<Flex
										align={{ base: "stretch", md: "center" }}
										direction={{ base: "column", md: "row" }}
										justify="space-between"
										gap="4"
										p="4"
										bg="bg.panel"
										borderRadius="l3"
										borderWidth="1px"
										borderColor="border.card"
									>
										<Stack gap="1">
											<Text textStyle="eyebrow" color="fg.muted">
												Project identity
											</Text>
											<Text fontSize="sm" color="fg.muted">
												Set the brand profile for future clips.
											</Text>
										</Stack>
										<Flex gap="2" align="center" minW={{ md: "360px" }}>
											<Select
												key={snapshot.project.brandProfileId ?? "unassigned"}
												name="profileId"
												ariaLabel="Brand profile"
												placeholder="Select a Brand Profile"
												defaultValue={
													snapshot.project.brandProfileId ?? undefined
												}
												items={brandProfiles.map((profile) => ({
													label: profile.name,
													value: profile.id,
												}))}
												flex="1"
												minW="0"
												size="sm"
												disabled={!canApplyBrandProfile}
											/>
											{!canEdit ? null : brandApplyUpgrade ? (
												<LockedButton type="button" size="sm" variant="subtle" prompt={brandApplyUpgrade}>
													Apply
												</LockedButton>
											) : (
												<ActionSubmitButton
													type="submit"
													size="sm"
													variant="subtle"
													pendingLabel="Applying…"
													disabled={!canApplyBrandProfile}
												>
													Apply
												</ActionSubmitButton>
											)}
										</Flex>
									</Flex>
									{canEdit && brandRequirement && !brandApplyUpgrade ? (
										<Text fontSize="xs" color="fg.muted" mt="2">
											{brandRequirement.message}
										</Text>
									) : null}
								</AuthenticatedActionForm>
							</Box>
						) : null}
					</Collapsible.Content>
				</Collapsible.Root>
				{viewOnlyNote ? (
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
							<Text fontSize="sm">{viewOnlyNote.message}</Text>
						</Flex>
						{viewOnlyNote.billingAction ? (
							<Button size="sm" variant="subtle" asChild>
								<Link href="/settings/billing">{viewOnlyNote.billingAction}</Link>
							</Button>
						) : null}
					</Flex>
				) : null}
				{/* Workspace tabs — URL-driven (?tab=); SSE stream shared via
          ProjectEventsProvider so the Clips-tab processing checklist and the
          Activity tab consume the same EventSource (no second connection). */}
				<PublishingProvider
					projectId={projectId}
					actorId={appUser.actorUserId}
					workspaceId={appUser.workspaceId}
					clips={clips}
					accounts={socialAccounts}
			initialPosts={socialPosts.items}
			initialPostsCursor={socialPosts.nextCursor}
					workspaceTimezone={activeWorkspace?.timezone ?? "UTC"}
					can1080pExport={can1080pExport}
					canOverrideReview={canOverrideReview}
					canPublish={workspaceAllowsCapability(access, "publishing.manage")}
					publishingUpgrade={publishingUpgrade}

					assistedCopyEnabled={hasFeature(
						pricingTier,
						"publishing.assistedCopy",
					)}
					assistedCopyUpgrade={featureUpgradePrompt(
						pricingTier,
						"publishing.assistedCopy",
						"Upgrade to write post descriptions with AI",
					)}
					customThumbnailsEnabled={hasFeature(
						pricingTier,
						"publishing.customThumbnails",
					)}
					customThumbnailsUpgrade={featureUpgradePrompt(
						pricingTier,
						"publishing.customThumbnails",
						"Upgrade to set custom thumbnails",
					)}
					campaignSchedulingEnabled={hasFeature(
						pricingTier,
						"campaign.operations",
					)}
					canUploadVisualAssets={
						hasFeature(pricingTier, "brand.profiles") &&
						workspaceAllowsCapability(
							{ role: appUser.role, status: appUser.status },
							"brand.manage",
						)
					}
				>
					<ProjectTabs clipsCountBadge={<TabCountBadge count={clips.length} />}>
						{/* CLIPS — processing panel while a run/ingest is in flight, ranked
            results once clips exist, setup step cards otherwise. */}
						<Tabs.Content value="clips" pt="6">
							{activeTab === "clips" ? (
								isDraftPack ? (
									<Flex
										align="center"
										justify="space-between"
										gap="3"
										wrap="wrap"
										p="4"
										bg="bg.panel"
										borderWidth="1px"
										borderColor="border.card"
										borderRadius="l3"
									>
										<Flex align="center" gap="2">
											<Info size={14} aria-hidden />
											<Text fontSize="sm" color="fg.muted">
												This project's setup isn't finished yet.
											</Text>
										</Flex>
										<Button size="sm" variant="subtle" asChild>
											<Link href={`/upload?project=${projectId}`}>
												Finish setup
											</Link>
										</Button>
									</Flex>
								) : showProcessingPanel ? (
									<ProcessingPanel
										projectId={projectId}
										mediaWell={
											<MediaWell
												ratio={16 / 9}
												timecode={
													typeof durationSec === "number" && durationSec > 0
														? formatDuration(durationSec)
														: undefined
												}
											>
												<SourceThumb
													projectId={projectId}
													title={snapshot.project.title}
													sourceType={snapshot.project.sourceType}
													sourceInput={snapshot.project.sourceInput}
													sourceMediaUrl={snapshot.project.sourceMediaUrl}
												/>
											</MediaWell>
										}
										projectTitle={snapshot.project.title}
										durationSec={durationSec}
										notifyOnComplete={snapshot.project.notifyOnComplete}
										ingestStatus={snapshot.project.ingestStatus}
										ingestErrorCode={snapshot.project.ingestErrorCode}
										ingestAttemptsExhausted={ingestAttemptsExhausted}
										ingestFromDrivePicker={ingestFromDrivePicker}
										ingestRetryLimitMessage={ingestRetryLimitMessage}
										transcribe={transcribeStage}
										detect={detectStage}
										render={renderStage}
										mode={generationMode}
										workflowRunId={activeRun?.workflowRunId ?? null}
										quotaBlockedMessage={quotaBlockedMessage}
										quotaUpgrade={quotaUpgrade}
										advancedSettingsProps={advancedSettingsProps}
										defaultSourceLanguageCode={snapshot.project.languageCode}
										canEdit={canEdit}
									/>
								) : !transcriptReady ? (
									<AuthenticatedActionForm
										action={queueTranscriptionFormAction}
									>
										<input type="hidden" name="projectId" value={projectId} />
										<input
											type="hidden"
											name="idempotencyKey"
											value={randomUUID()}
										/>
										<Stack gap="4">
											<Flex
												align="flex-start"
												justify="space-between"
												gap="4"
												wrap="wrap"
											>
												<Box>
													<Text fontSize="16px" fontWeight="500" color="fg">
														AI Transcription
													</Text>
													<Text fontSize="sm" color="fg.muted" mt="0.5">
														Queue transcription with the current clip
														preferences.
													</Text>
													{!isIngestReady && (
														<Flex
															align="center"
															gap="1.5"
															mt="1.5"
															color="warning.fg"
														>
															<AlertTriangle size={13} aria-hidden />
															<Text fontSize="xs">
																Transcription is disabled until ingest is ready.
															</Text>
														</Flex>
													)}
													<PlanLimitNotice
														message={planLimitMessage}
														upgrade={sourceCredits ? uploadLengthUpgradePrompt(pricingTier, sourceSeconds, sourceCredits) : null}
													/>
												</Box>
												{canEdit ? (
													<ActionSubmitButton
														pendingLabel="Starting…"
														disabled={
															!isIngestReady ||
															transcriptInFlight ||
															planLimitMessage !== null
														}
														type="submit"
														size="sm"
														flexShrink={0}
													>
														{transcriptInFlight
															? "Transcribing…"
															: "Start transcription"}
													</ActionSubmitButton>
												) : null}
											</Flex>
											{canEdit ? (
												<AdvancedClipSettings
													{...advancedSettingsProps}
													sourceLanguageEditable={true}
													defaultSourceLanguageCode={
														snapshot.project.languageCode
													}
												/>
											) : null}
										</Stack>
									</AuthenticatedActionForm>
								) : clips.length === 0 ? (
									<AuthenticatedActionForm action={regenerateClipsFormAction}>
										<input type="hidden" name="projectId" value={projectId} />
										<input
											type="hidden"
											name="idempotencyKey"
											value={randomUUID()}
										/>
										<Stack gap="4">
											<Flex
												align="flex-start"
												justify="space-between"
												gap="4"
												wrap="wrap"
											>
												<Box>
													<Text fontSize="16px" fontWeight="500" color="fg">
														AI Clip Detection
													</Text>
													<Text fontSize="sm" color="fg.muted" mt="0.5">
														Detect clip-worthy moments and score them for
														virality.
													</Text>
												</Box>
												{canEdit ? (
													<ActionSubmitButton
														pendingLabel="Starting…"
														size="sm"
														flexShrink={0}
														disabled={detectionInFlight}
													>
														{detectionInFlight ? "Detecting…" : "Detect clips"}
													</ActionSubmitButton>
												) : null}
											</Flex>
											{canEdit ? (
												<AdvancedClipSettings
													{...advancedSettingsProps}
													sourceLanguageEditable={false}
													defaultSourceLanguageCode={
														snapshot.project.languageCode
													}
												/>
											) : null}
										</Stack>
									</AuthenticatedActionForm>
								) : (
									<Stack gap="5">
										{/* No "Regenerate clips" affordance once a clip set exists —
                  market-aligned with Vizard's one-shot clipping model. Failed
                  and zero-clip runs still expose Retry/Re-run detection in
                  the processing panel, and the first detection is Step 02. */}
										{!hasFeature(pricingTier, "export.noWatermark") && hasRenderableClips && (
											<UpgradeBanner
												message="Export in 1080p without the watermark."
												tier={lowestTierWithFeature("export.noWatermark")}
												canManageBilling={appUser.role === "owner"}
											/>
										)}
										{/* Ranked-row results (Phase 3). The view's single solid
                  ultramarine button — "Render selected" — lives in this
                  panel's toolbar; there is no standalone render-all button
                  here anymore. */}
										<ClipsPanel
											clips={clips}
											projectId={projectId}
											mode={generationMode}
											isFreeTier={!hasFeature(pricingTier, "export.noWatermark")}
											can1080pExport={can1080pExport}
											defaultAspectRatio={clipsDefaultAspectRatio}
											sourceVideoUrl={sourceVideoUrl}
											actionAvailability={campaignActionAvailability}
											upgradePrompts={campaignUpgradePrompts}
											canEdit={canEdit}
										/>
									</Stack>
								)
							) : null}
						</Tabs.Content>

						{/* TRANSCRIPT */}
						<Tabs.Content value="transcript" pt="6">
							{activeTab === "transcript" ? (
								<TranscriptPanel
									projectId={projectId}
									transcript={fullTranscript}
								/>
							) : null}
						</Tabs.Content>

						{/* REPURPOSE */}
						<Tabs.Content value="repurpose" pt="6">
							{activeTab === "repurpose" ? (
								transcriptReady ? (
									<ContentSuitePanel
										projectId={projectId}
										transcriptReady={transcriptReady}
										planRequirement={planFeatureRequirement(pricingTier, "content.repurposing")?.message ?? null}
										upgrade={contentSuiteUpgrade}
										canEdit={canEdit}
									/>
								) : (
									<EmptyState
										title="Transcript required"
										description={
											transcriptInFlight
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

						{/* DUBBING */}
						<Tabs.Content value="dubbing" pt="6">
							{activeTab === "dubbing" ? (
								<DubbingPanel
									projectId={projectId}
									clips={clips}
									dubs={dubs}
									allowance={dubAllowance}
									planRequirement={planFeatureRequirement(pricingTier, "dubbing")?.message ?? null}
									upgrade={dubbingUpgrade}
									canEdit={canEdit}
								/>
							) : null}
						</Tabs.Content>

						{/* REVIEW */}
						<Tabs.Content value="review" pt="6">
							{activeTab === "review" && reviewRoomData ? (
								<ReviewPanel
									projectId={projectId}
									initialData={reviewRoomData}
									canManage={canManageReview}
									preselection={reviewPreselection}
								/>
							) : null}
						</Tabs.Content>

						<Tabs.Content value="posts" pt="6">
							{activeTab === "posts" ? <ProjectPosts /> : null}
						</Tabs.Content>

						{/* ANALYTICS */}
						<Tabs.Content value="analytics" pt="6">
							{activeTab === "analytics" && analytics ? (
								<AnalyticsPanel analytics={analytics} clips={clips} />
							) : null}
						</Tabs.Content>

						{/* ACTIVITY — keep mounted regardless of active tab: the SSE stream
            (owned by ProjectEventsProvider above) drives router.refresh()
            for the whole workspace. */}
						<Tabs.Content value="activity" pt="6">
							<ProjectEvents />
						</Tabs.Content>
					</ProjectTabs>
				</PublishingProvider>
			</ProjectEventsProvider>
		</Stack>
	);
}
