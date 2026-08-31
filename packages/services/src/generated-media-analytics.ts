import { getPrismaClient } from "@narriflow/db/client";
import {
	resolvePricingTier,
	type GeneratedMediaAnalyticsEventInput,
} from "@narriflow/validators";

import { analyticsService } from "./analytics.service";
import type { GeneratedMediaEventSink } from "./generated-media";

type GeneratedMediaAnalyticsJob = {
	kind: "image" | "video";
	providerAlias: string;
	modelAlias: string;
	status:
		| "queued"
		| "running"
		| "waiting"
		| "completed"
		| "failed"
		| "rejected"
		| "cancelled";
	createdAt: Date;
	retryCount: number;
	moderationOutcome: "pending" | "passed" | "rejected";
	usageUnits: number;
};

export function generatedMediaLatencyBucket(
	latencyMs: number,
): "under_10s" | "under_1m" | "under_5m" | "5m_plus" {
	if (latencyMs < 10_000) return "under_10s";
	if (latencyMs < 60_000) return "under_1m";
	if (latencyMs < 5 * 60_000) return "under_5m";
	return "5m_plus";
}

export function createGeneratedMediaAnalyticsSink(dependencies: {
	recordEvent: (input: GeneratedMediaAnalyticsEventInput) => Promise<void>;
	resolveWorkspacePlan: (
		workspaceId: string,
	) => Promise<"free" | "creator" | "pro" | "business">;
	readJob: (input: {
		jobId: string;
		workspaceId: string;
		projectId: string;
	}) => Promise<GeneratedMediaAnalyticsJob | null>;
	now?: () => Date;
}): GeneratedMediaEventSink {
	const now = dependencies.now ?? (() => new Date());
	return {
		async recordCompleted(input) {
			const planTier = await dependencies.resolveWorkspacePlan(input.workspaceId);
			await dependencies.recordEvent({
				type: "generated_asset_completed",
				projectId: input.projectId,
				clipId: input.clipId,
				metadata: {
					kind: input.kind,
					providerAlias: input.providerAlias,
					modelAlias: input.modelAlias,
					status: input.status,
					latencyBucket: generatedMediaLatencyBucket(input.latencyMs),
					retryCount: input.retryCount,
					moderationOutcome: input.moderationOutcome,
					usageUnits: input.usageUnits,
					outcome: "succeeded",
					planTier,
				},
			});
		},
		async recordInserted(input) {
			const job = await dependencies.readJob(input);
			if (!job) return;
			await dependencies.recordEvent({
				type: "generated_asset_inserted",
				projectId: input.projectId,
				clipId: input.clipId,
				metadata: {
					kind: job.kind,
					providerAlias: job.providerAlias,
					modelAlias: job.modelAlias,
					status: job.status,
					latencyBucket: generatedMediaLatencyBucket(
						Math.max(0, now().getTime() - job.createdAt.getTime()),
					),
					retryCount: job.retryCount,
					moderationOutcome: job.moderationOutcome,
					usageUnits: job.usageUnits,
					insertionAction: input.insertionAction,
					outcome: input.outcome,
					planTier: input.planTier,
				},
			});
		},
	};
}

export function createProductionGeneratedMediaAnalyticsSink(): GeneratedMediaEventSink {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return createGeneratedMediaAnalyticsSink({
		recordEvent: (input) => analyticsService.recordGeneratedMediaEvent(input),
		async resolveWorkspacePlan(workspaceId) {
			const workspace = await prisma.workspace.findUnique({
				where: { id: workspaceId },
				select: { pricingTier: true },
			});
			return resolvePricingTier(workspace?.pricingTier);
		},
		async readJob(input) {
			const job = await prisma.generatedMediaJob.findFirst({
				where: {
					id: input.jobId,
					workspaceId: input.workspaceId,
					projectId: input.projectId,
				},
				include: { usage: true },
			});
			if (!job?.usage) return null;
			return {
				kind: job.kind as "image" | "video",
				providerAlias: job.provider,
				modelAlias: job.model,
				status: job.status as GeneratedMediaAnalyticsJob["status"],
				createdAt: job.createdAt,
				retryCount: Math.max(0, job.attemptCount - 1),
				moderationOutcome:
					job.moderationOutcome as GeneratedMediaAnalyticsJob["moderationOutcome"],
				usageUnits:
					job.usage.status === "finalized"
						? job.usage.finalizedUnits
						: job.usage.reservedUnits,
			};
		},
	});
}
