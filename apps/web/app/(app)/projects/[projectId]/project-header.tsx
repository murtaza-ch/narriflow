"use client";

import Link from "next/link";
import { Box, Collapsible, Flex, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, ChevronDown, Info } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { userErrorMessage } from "@narriflow/validators";
import { getDisplayName, getInitials } from "@/lib/account-display";
import { formatDate, formatDuration } from "@/lib/format";
import { ingestRecoveryAction, ingestRecoveryLabel } from "@/lib/project-state";
import { DeleteProjectButton } from "../_components/delete-project-button";
import { ProjectExpiration } from "../_components/project-expiration";
import { FinishingStatus } from "./finishing-status";
import { PipelineStepper } from "./pipeline-stepper";
import { ProjectBrandPicker } from "./project-brand-picker";
import { ProjectShareButton } from "./project-share-button";
import type { PlanFacts, ProjectDetailData, ProjectRecord, ProjectView } from "./project-view-model";
import { SourceIcon } from "./source-icon";
import { SourceThumb } from "./source-thumb";
import { RetryIngestButton } from "./render-clips-button";

export interface ProjectActor {
	firstName: string | null;
	lastName: string | null;
	email: string | null;
	imageUrl: string | null;
}

/**
 * Title, source facts, share and delete, and the collapsible details: poster,
 * pipeline, ingest recovery and brand. The collapsible opens by itself while
 * something needs attention (no clips, work in flight, an error).
 */
export function ProjectHeader({
	projectId,
	project,
	detail,
	view,
	plan,
	actor,
	processingPanelVisible,
}: {
	projectId: string;
	project: ProjectRecord;
	detail: ProjectDetailData;
	view: ProjectView;
	plan: PlanFacts;
	actor: ProjectActor;
	processingPanelVisible: boolean;
}) {
	const { finishing, clips } = detail;
	const durationSec = project.sourceDurationSeconds;
	const hasDuration = typeof durationSec === "number" && durationSec > 0;
	const brandChoices = detail.tab === "clips" ? detail.tabData.brandChoices : [];
	const retryRecovery = project.ingestErrorCode
		? ingestRecoveryAction(project.ingestErrorCode, view.ingestFromDrivePicker)
		: null;

	return (
		<Collapsible.Root
			defaultOpen={
				clips.length === 0 ||
				view.ingestInProgress ||
				view.runInFlight ||
				view.runFailed ||
				Boolean(project.ingestErrorCode) ||
				view.activeRun?.status === "partial"
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
					<Text as="h1" textStyle="title" fontSize={{ base: "xl", md: "24px" }} color="fg" lineClamp={2}>
						{project.title}
					</Text>
					<Flex align="center" gap="3" wrap="wrap">
						<SourceIcon sourceType={project.sourceType} sourceProvider={project.sourceProvider} />
						{hasDuration && (
							<Text fontSize="xs" color="fg.subtle">
								{formatDuration(durationSec)}
							</Text>
						)}
						<Text fontSize="xs" color="fg.subtle">
							{formatDate(project.createdAt)}
						</Text>
						{project.expiresAt ? <ProjectExpiration expiresAt={project.expiresAt} /> : null}
						{view.headerBadge && <StatusBadge status={view.headerBadge.status} label={view.headerBadge.label} />}
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
					{view.canManageReview ? (
						<ProjectShareButton
							projectId={projectId}
							upgrade={plan.shareUpgrade}
							actor={{
								name: getDisplayName(actor.firstName, actor.lastName),
								email: actor.email,
								imageUrl: actor.imageUrl,
								initials: getInitials(actor.firstName, actor.lastName, actor.email),
								role: detail.access.role,
							}}
						/>
					) : null}
					{view.canEdit ? (
						<DeleteProjectButton projectId={projectId} projectTitle={project.title} variant="menu" />
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
						timecode={hasDuration ? formatDuration(durationSec) : undefined}
					>
						<SourceThumb
							projectId={projectId}
							title={project.title}
							sourceType={project.sourceType}
							sourceInput={project.sourceInput}
							sourceMediaUrl={project.sourceMediaUrl}
						/>
					</MediaWell>

					<Stack flex="1" minW="0" gap="3">
						{processingPanelVisible ? null : (
							<PipelineStepper steps={view.steps} workflowRunId={view.activeRun?.workflowRunId ?? null} />
						)}
						{view.isSourceExpired && (
							<Flex align="center" gap="2" color="fg.muted">
								<Info size={13} aria-hidden />
								<Text fontSize="xs">
									The original source was cleared after retention to save storage. Existing clips and
									renders are unaffected.
								</Text>
							</Flex>
						)}
						{view.activeRun?.status === "partial" && (
							<Flex align="center" gap="2" color="warning.fg">
								<AlertTriangle size={14} aria-hidden />
								<Text fontSize="sm">
									Some outputs failed, but successful clips remain ready to use. Retry only the failed
									outputs from their rows.
								</Text>
							</Flex>
						)}
						{finishing && <FinishingStatus projectId={projectId} finishing={finishing} />}
						{project.ingestErrorCode && (
							<Stack gap="2">
								<Flex align="center" gap="2" color="danger.fg">
									<AlertTriangle size={14} aria-hidden />
									<Text fontSize="sm">{userErrorMessage(project.ingestErrorCode)}</Text>
								</Flex>
								{view.canEdit && view.isIngestFailed && retryRecovery === "retry" && (
									<RetryIngestButton
										projectId={projectId}
										disabled={view.ingestAttemptsExhausted}
										limitReachedMessage={view.ingestRetryLimitMessage}
									/>
								)}
								{view.canEdit && view.isIngestFailed && retryRecovery === "new_upload" && (
									<Button size="sm" variant="subtle" asChild alignSelf="flex-start">
										<Link href="/upload">{ingestRecoveryLabel(view.ingestFromDrivePicker)}</Link>
									</Button>
								)}
							</Stack>
						)}
					</Stack>
				</Flex>

				{brandChoices.length > 0 ? (
					<Box mt="5">
						<ProjectBrandPicker
							projectId={projectId}
							brands={brandChoices}
							currentBrandId={project.brandProfileId}
							canEdit={view.canEdit}
							upgrade={plan.brandUpgrade}
							requirementMessage={plan.brandRequirement?.message ?? null}
						/>
					</Box>
				) : null}
			</Collapsible.Content>
		</Collapsible.Root>
	);
}
