"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Info } from "lucide-react";
import { lowestTierWithFeature, hasFeature } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { UpgradeBanner } from "../../_components/upgrade";
import { formatDuration } from "@/lib/format";
import { AdvancedClipSettings } from "./advanced-clip-settings";
import type { deriveCampaignActionPlan } from "./campaign-command-state";
import { ClipsPanel } from "./clips-panel";
import { ProcessingPanel } from "./processing-panel";
import type { ProjectDetailData, ProjectRecord, ProjectView } from "./project-view-model";
import { RenderStatusNotice } from "./render-status-notice";
import { SourceHoverPreview } from "./source-hover-preview";
import { SourceThumb } from "./source-thumb";
import { useProjectGeneration } from "./use-project-generation";

type CampaignPlan = ReturnType<typeof deriveCampaignActionPlan>;

/**
 * The Clips tab: a draft pack points back to setup, the processing panel shows
 * while a run or ingest is in flight, and otherwise the setup cards (transcribe,
 * then detect) give way to the ranked clips once any exist.
 */
export function ProjectClipsTab({
	projectId,
	detail,
	project,
	view,
	campaign,
	sourceVideoUrl,
	canManageBilling,
}: {
	projectId: string;
	detail: ProjectDetailData;
	project: ProjectRecord;
	view: ProjectView;
	campaign: CampaignPlan;
	sourceVideoUrl: string | null;
	canManageBilling: boolean;
}) {
	const { clips } = detail;
	const durationSec = project.sourceDurationSeconds;
	const timecode = typeof durationSec === "number" && durationSec > 0 ? formatDuration(durationSec) : undefined;

	if (view.isDraftPack) {
		return (
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
					<Link href={`/upload?project=${projectId}`}>Finish setup</Link>
				</Button>
			</Flex>
		);
	}

	if (view.showProcessingPanel) {
		return (
			<ProcessingPanel
				projectId={projectId}
				mediaWell={
					<MediaWell ratio={16 / 9} timecode={timecode}>
						<SourceHoverPreview src={sourceVideoUrl}>
							<SourceThumb
								projectId={projectId}
								title={project.title}
								sourceType={project.sourceType}
								sourceInput={project.sourceInput}
								sourceMediaUrl={project.sourceMediaUrl}
							/>
						</SourceHoverPreview>
					</MediaWell>
				}
				projectTitle={project.title}
				notifyOnComplete={project.notifyOnComplete}
				ingestStatus={project.ingestStatus}
				ingestErrorCode={project.ingestErrorCode}
				ingestAttemptsExhausted={view.ingestAttemptsExhausted}
				ingestFromDrivePicker={view.ingestFromDrivePicker}
				ingestRetryLimitMessage={view.ingestRetryLimitMessage}
				transcribe={view.transcribe}
				detect={view.detect}
				render={view.render}
				mode={view.generationMode}
				workflowRunId={view.activeRun?.workflowRunId ?? null}
				quotaBlockedMessage={view.quotaBlockedMessage}
				quotaUpgrade={view.quotaUpgrade}
				advancedSettingsProps={view.advancedSettings}
				defaultSourceLanguageCode={project.languageCode}
				canEdit={view.canEdit}
			/>
		);
	}

	if (!view.transcriptReady) {
		return (
			<SetupCard
				projectId={projectId}
				kind="transcription"
				title="AI Transcription"
				description="Queue transcription with the current clip preferences."
				actionLabel={view.transcriptInFlight ? "Transcribing…" : "Start transcription"}
				disabled={!view.isIngestReady || view.transcriptInFlight || view.planLimitMessage !== null}
				canEdit={view.canEdit}
				notice={
					<>
						{!view.isIngestReady && (
							<Flex align="center" gap="1.5" mt="1.5" color="warning.fg">
								<AlertTriangle size={13} aria-hidden />
								<Text fontSize="xs">Transcription is disabled until ingest is ready.</Text>
							</Flex>
						)}
						<PlanLimitNotice message={view.planLimitMessage} upgrade={view.lengthUpgrade} />
					</>
				}
				settings={
					<AdvancedClipSettings
						{...view.advancedSettings}
						sourceLanguageEditable={true}
						defaultSourceLanguageCode={project.languageCode}
					/>
				}
			/>
		);
	}

	if (clips.length === 0) {
		return (
			<SetupCard
				projectId={projectId}
				kind="detection"
				title="AI Clip Detection"
				description="Detect clip-worthy moments and score them for virality."
				actionLabel={view.detectionInFlight ? "Detecting…" : "Detect clips"}
				disabled={view.detectionInFlight}
				canEdit={view.canEdit}
				settings={
					<AdvancedClipSettings
						{...view.advancedSettings}
						sourceLanguageEditable={false}
						defaultSourceLanguageCode={project.languageCode}
					/>
				}
			/>
		);
	}

	const isFreeTier = !hasFeature(view.pricingTier, "export.noWatermark");
	return (
		<Stack gap="5">
			{/* No "Regenerate clips" affordance once a clip set exists — market-aligned
			    with Vizard's one-shot clipping model. Failed and zero-clip runs still
			    expose Retry/Re-run detection in the processing panel, and the first
			    detection is Step 02. */}
			{isFreeTier && (
				<UpgradeBanner
					message="Export in 1080p without the watermark."
					tier={lowestTierWithFeature("export.noWatermark")}
					canManageBilling={canManageBilling}
				/>
			)}
			<RenderStatusNotice projectId={projectId} status={view.renderStatus} canEdit={view.canEdit} />
			{/* Ranked-row results. The view's single solid button — "Render selected" —
			    lives in this panel's toolbar. */}
			<ClipsPanel
				clips={clips}
				projectId={projectId}
				mode={view.generationMode}
				isFreeTier={isFreeTier}
				can1080pExport={hasFeature(view.pricingTier, "export.1080p")}
				defaultAspectRatio={view.defaultAspectRatio}
				sourceVideoUrl={sourceVideoUrl}
				actionAvailability={campaign.availability}
				upgradePrompts={campaign.upgradePrompts}
				canEdit={view.canEdit}
			/>
		</Stack>
	);
}

/** One setup step: a title, its action and the processing settings the action submits. */
function SetupCard({
	projectId,
	kind,
	title,
	description,
	actionLabel,
	disabled,
	canEdit,
	notice,
	settings,
}: {
	projectId: string;
	kind: "transcription" | "detection";
	title: string;
	description: string;
	actionLabel: string;
	disabled: boolean;
	canEdit: boolean;
	notice?: ReactNode;
	settings: ReactNode;
}) {
	const { pending, error, onSubmit } = useProjectGeneration(projectId, kind);
	return (
		<form onSubmit={onSubmit}>
			<Stack gap="4">
				<Flex align="flex-start" justify="space-between" gap="4" wrap="wrap">
					<Box>
						<Text fontSize="16px" fontWeight="500" color="fg">
							{title}
						</Text>
						<Text fontSize="sm" color="fg.muted" mt="0.5">
							{description}
						</Text>
						{notice}
					</Box>
					{canEdit ? (
						<Button
							type="submit"
							size="sm"
							flexShrink={0}
							disabled={disabled}
							loading={pending}
							loadingText="Starting…"
						>
							{actionLabel}
						</Button>
					) : null}
				</Flex>
				{error ? (
					<Flex align="center" gap="1.5" color="danger.fg">
						<AlertTriangle size={12} aria-hidden />
						<Text fontSize="xs">{error}</Text>
					</Flex>
				) : null}
				{canEdit ? settings : null}
			</Stack>
		</form>
	);
}
