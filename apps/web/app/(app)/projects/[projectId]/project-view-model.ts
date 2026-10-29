import type { ProjectDetail } from "@narriflow/api-client/projects";
import {
	BRAND_DEFAULT_CAPTION_PRESET_ID,
	brandPlanRequirement,
	captionPresetIdSchema,
	creditsForSourceSeconds,
	type CaptionPresetId,
	defaultAspectRatioSchema,
	deriveProjectPipeline,
	hasFeature,
	isQuotaBlockedMidFlight,
	MAX_INGEST_RETRY_ATTEMPTS,
	planDefinition,
	planFeatureRequirement,
	planUpgradeHighlight,
	type PricingTier,
	workspaceAllowsCapability,
} from "@narriflow/validators";
import type { UpgradePrompt } from "../../_components/upgrade";
import { creditsUpgradePrompt, uploadLengthUpgradePrompt } from "@/lib/authenticated-request-browser";
import { dubAllowanceUpgradePrompt, featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import type { PipelineStepView } from "@/lib/project-state";
import { extractYoutubeId, youtubeFrameUrls } from "../_lib/youtube";
import { deriveCampaignActionPlan } from "./campaign-command-state";
import { projectViewOnlyNote } from "./project-access";

/**
 * Everything the Project screen decides from one detail aggregate: access,
 * plan prompts, ingest and quota facts and the pipeline. The API sends facts
 * (`access`, `usage`, `creditUsage`, the snapshot); the plan and capability
 * rules come from the shared validators helpers, so what the page offers
 * matches what the services refuse with. Pure, so every case is testable.
 */

export type ProjectDetailData = ProjectDetail;
export type ProjectRecord = NonNullable<ProjectDetail["snapshot"]["project"]>;
type BrandRequirement = { requiredTier: PricingTier | null; message: string } | null;

/** The plan rule for applying a Brand Profile: the one policy the service refuses with. */
export function brandApplyRequirement(
	scope: { pricingTier: PricingTier; isPersonalWorkspace: boolean },
): BrandRequirement {
	return brandPlanRequirement(scope, "brand.profiles");
}

export function brandApplyUpgradePrompt(requirement: BrandRequirement): UpgradePrompt | null {
	return requirement?.requiredTier
		? {
				tier: requirement.requiredTier,
				headline: "Upgrade to brand your clips",
				highlight: planUpgradeHighlight(requirement.requiredTier, "brand.profiles"),
			}
		: null;
}

export interface AdvancedSettingsFacts {
	sourceDurationSec: number | null;
	sourceFrames: string[];
	defaultProcessingStartSec: number | null;
	defaultProcessingEndSec: number | null;
	defaultCaptionPreset: CaptionPresetId;
}

/**
 * What the plan decides on this screen: the prompts and flags every tab hands
 * to its panels. Depends only on the tier and Workspace kind, so the screen
 * memoizes it on those two and the panels keep stable props across refetches.
 */
export function derivePlanFacts(pricingTier: PricingTier, isPersonalWorkspace: boolean) {
	// The same rule the service applies when branding is applied.
	const brandRequirement = brandApplyRequirement({ pricingTier, isPersonalWorkspace });
	return {
		brandRequirement,
		brandUpgrade: brandApplyUpgradePrompt(brandRequirement),
		campaign: deriveCampaignActionPlan({ pricingTier, brandRequirement }),
		can1080pExport: hasFeature(pricingTier, "export.1080p"),
		shareUpgrade: featureUpgradePrompt(pricingTier, "review.rooms", "Upgrade to share projects for client review"),
		publishingUpgrade: featureUpgradePrompt(pricingTier, "publishing.schedule", "Upgrade to publish your clips"),
		assistedCopyEnabled: hasFeature(pricingTier, "publishing.assistedCopy"),
		assistedCopyUpgrade: featureUpgradePrompt(
			pricingTier,
			"publishing.assistedCopy",
			"Upgrade to write post descriptions with AI",
		),
		customThumbnailsEnabled: hasFeature(pricingTier, "publishing.customThumbnails"),
		customThumbnailsUpgrade: featureUpgradePrompt(
			pricingTier,
			"publishing.customThumbnails",
			"Upgrade to set custom thumbnails",
		),
		campaignSchedulingEnabled: hasFeature(pricingTier, "campaign.operations"),
		contentSuiteRequirement: planFeatureRequirement(pricingTier, "content.repurposing")?.message ?? null,
		contentSuiteUpgrade: featureUpgradePrompt(pricingTier, "content.repurposing", "Upgrade to repurpose your videos"),
		dubbingRequirement: planFeatureRequirement(pricingTier, "dubbing")?.message ?? null,
	};
}

export type PlanFacts = ReturnType<typeof derivePlanFacts>;

export function deriveProjectView(detail: ProjectDetail, project: ProjectRecord) {
	const { access, usage, snapshot, clips, contentPack, creditUsage } = detail;
	const pricingTier = usage.tier;
	const capability = { role: access.role, status: access.status };

	const canManageReview = workspaceAllowsCapability(capability, "review.manage");
	const canOverrideReview = workspaceAllowsCapability(capability, "review.override");
	// Every project mutation needs `content.edit` (or a capability granted with it).
	const canEdit = workspaceAllowsCapability(capability, "content.edit");
	const canPublish = workspaceAllowsCapability(capability, "publishing.manage");
	const canUploadVisualAssets =
		hasFeature(pricingTier, "brand.profiles") && workspaceAllowsCapability(capability, "brand.manage");
	const viewOnlyNote = projectViewOnlyNote(capability);

	const transcript = detail.transcript.data;
	const transcriptReady = transcript?.status === "completed";
	const transcriptInFlight = transcript?.status === "queued" || transcript?.status === "processing";

	// Ingest. Ready only once sourceStorageKey is set, so a null key afterwards
	// means the source was reclaimed after retention, not a broken upload.
	const isIngestReady = project.ingestStatus === "ready";
	const isIngestFailed = project.ingestStatus === "failed";
	const ingestInProgress = !isIngestReady && !isIngestFailed;
	const ingestAttemptsExhausted = snapshot.ingestAttemptCount >= MAX_INGEST_RETRY_ATTEMPTS;
	// A Google Drive Picker import can't be retried: its token ended with its job.
	const ingestFromDrivePicker = snapshot.ingestJobType === "drive_import";
	const ingestRetryLimitMessage = `Retry limit reached (${snapshot.ingestAttemptCount}/${MAX_INGEST_RETRY_ATTEMPTS}). This source keeps failing to import.`;
	const isSourceExpired = isIngestReady && !project.sourceStorageKey;

	// The per-video cap is deterministic, so show it before the click. Credits are
	// decided by Processing Usage settlement; once the Project is settled (or
	// refunded) a retry skips the length and credit checks.
	const sourceSeconds = project.sourceDurationSeconds ?? 0;
	const settlementFinal = creditUsage?.state === "settled" || creditUsage?.state === "refunded";
	const planLimitMessage =
		!settlementFinal && sourceSeconds > usage.maxUploadSeconds
			? `This source is ${Math.ceil(sourceSeconds / 60)} min, over the ${Math.round(
					usage.maxUploadSeconds / 60,
				)}-min per-video limit on the ${planDefinition(pricingTier).name} plan.`
			: null;
	// Cover this source once in the period its next attempt checks. Without a
	// known duration or ledger facts no specific plan can be promised.
	const sourceCredits =
		sourceSeconds > 0 && creditUsage && !settlementFinal
			? {
					spentCredits: creditUsage.spentCredits,
					requestedCredits: creditsForSourceSeconds(sourceSeconds),
				}
			: null;
	const lengthUpgrade = sourceCredits ? uploadLengthUpgradePrompt(pricingTier, sourceSeconds, sourceCredits) : null;

	const quotaBlockedMidFlight = isQuotaBlockedMidFlight({ ingestErrorCode: project.ingestErrorCode });
	// A plan only helps when one qualifies; at the top the notice just explains.
	const quotaUpgrade =
		!quotaBlockedMidFlight || !sourceCredits
			? null
			: project.ingestErrorCode === "upload_too_long"
				? lengthUpgrade
				: creditsUpgradePrompt(pricingTier, sourceCredits.spentCredits, sourceCredits.requestedCredits);
	// Length never recovers on renewal: an overlong source needs a qualifying
	// plan or a shorter replacement. Only spent credits wait for the renewal.
	const quotaBlockedMessage = quotaBlockedMidFlight
		? project.ingestErrorCode === "upload_too_long"
			? `This source is longer than the ${Math.round(usage.maxUploadSeconds / 60)}-min per-video limit on ${planDefinition(usage.tier).name}. ${
					quotaUpgrade
						? "Upgrade to a plan that fits it, or replace it with a shorter source."
						: sourceCredits
							? "No plan fits it, so replace it with a shorter source."
							: "Replace it with a shorter source, or check Billing for plans that allow longer videos."
				}`
			: `${usage.remainingCredits} of ${usage.limitCredits} ${planDefinition(usage.tier).name} credits remain this month, with a ${Math.round(
					usage.maxUploadSeconds / 60,
				)}-min per-video limit. Retry ${quotaUpgrade ? "after upgrading or " : ""}when credits renew on ${usage.renewsAt.slice(0, 10)} (UTC).`
		: null;

	// Generation settings of the latest content pack.
	const captionPreset = captionPresetIdSchema.safeParse(contentPack?.captionPreset);
	const defaultCaptionPreset = captionPreset.success ? captionPreset.data : BRAND_DEFAULT_CAPTION_PRESET_ID;
	const aspectRatio = defaultAspectRatioSchema.safeParse(contentPack?.defaultAspectRatio);
	const defaultAspectRatio = aspectRatio.success ? aspectRatio.data : "9:16";
	const sourceYoutubeId =
		project.sourceType === "youtube" ? extractYoutubeId(project.sourceInput, project.sourceMediaUrl) : null;
	const advancedSettings: AdvancedSettingsFacts = {
		sourceDurationSec: project.sourceDurationSeconds,
		// Drawn as a film strip behind the processing timeframe.
		sourceFrames: sourceYoutubeId ? youtubeFrameUrls(sourceYoutubeId) : [],
		defaultProcessingStartSec: contentPack?.processingStartSec ?? null,
		defaultProcessingEndSec: contentPack?.processingEndSec ?? null,
		defaultCaptionPreset,
	};

	// Link-first split: the latest pack may still be a draft — never treat a
	// draft as an active configuration.
	const isDraftPack = contentPack?.draft === true;
	const hasCommittedPack = contentPack !== null && !isDraftPack;
	const generationMode: "clip" | "caption_only" = contentPack?.mode === "caption_only" ? "caption_only" : "clip";

	// Pipeline derivation from stored workflow and status data.
	const activeRun = snapshot.activeRun;
	const pipeline = deriveProjectPipeline({
		ingestStatus: project.ingestStatus,
		transcript,
		clipCount: clips.length,
		latestRun: activeRun,
		renderVariants: clips.flatMap((clip) => clip.renderVariants),
		socialPosts: detail.socialPosts.items,
	});
	const { transcribe, detect, render } = pipeline.processingStages;
	const runInFlight =
		activeRun !== null &&
		(activeRun.status === "queued" || activeRun.status === "running" || activeRun.status === "waiting");
	const runFailed = activeRun !== null && activeRun.status === "failed";

	// The Clips tab shows the processing panel instead of the setup cards while a
	// run is in flight, or ingest is still running/failed with a committed pack,
	// or quota was crossed mid-flight. Processing stays visible until rendering succeeds.
	const renderStageSucceeded = render.status === "completed" || render.status === "partial";
	const showProcessingPanel =
		hasCommittedPack &&
		(clips.length === 0
			? ingestInProgress || isIngestFailed || runInFlight || runFailed || quotaBlockedMidFlight
			: pipeline.hasUnfinishedProcessing || !renderStageSucceeded);

	const steps: PipelineStepView[] = [
		{ label: "Ingest", state: pipeline.ingest, status: project.ingestStatus },
		{ label: "Transcribe", state: pipeline.transcribe, status: transcribe.status },
		{ label: "Detect", state: pipeline.detect, status: detect.status },
		{ label: "Render", state: pipeline.render, status: render.status },
		{ label: "Publish", state: pipeline.publish },
	];

	return {
		pricingTier,
		canManageReview,
		canOverrideReview,
		canEdit,
		canPublish,
		canUploadVisualAssets,
		viewOnlyNote,
		transcriptReady,
		transcriptInFlight,
		isIngestReady,
		isIngestFailed,
		ingestInProgress,
		ingestAttemptsExhausted,
		ingestFromDrivePicker,
		ingestRetryLimitMessage,
		isSourceExpired,
		planLimitMessage,
		lengthUpgrade,
		quotaBlockedMessage,
		quotaUpgrade,
		defaultAspectRatio,
		advancedSettings,
		isDraftPack,
		generationMode,
		activeRun,
		runInFlight,
		runFailed,
		detectionInFlight: pipeline.detect === "active",
		transcribe,
		detect,
		render,
		showProcessingPanel,
		steps,
	};
}

export type ProjectView = ReturnType<typeof deriveProjectView>;

/** The dubbing offer: a plan that dubs *and* has room after this month's dubs, or none. */
export function dubbingUpgradeFor(
	pricingTier: PricingTier,
	allowance: ProjectDetail["tabData"]["dubAllowance"],
): UpgradePrompt | null {
	// Without usage facts, fall back to the plan that dubs at all.
	const allowanceUpgrade = allowance ? dubAllowanceUpgradePrompt(pricingTier, allowance.used) : null;
	if (!hasFeature(pricingTier, "dubbing")) {
		return allowance
			? allowanceUpgrade && { ...allowanceUpgrade, headline: "Upgrade to dub your clips" }
			: featureUpgradePrompt(pricingTier, "dubbing", "Upgrade to dub your clips");
	}
	return allowance && allowance.remaining <= 0 ? allowanceUpgrade : null;
}
