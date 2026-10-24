import { getPrismaClient } from "@narriflow/db/client";
import type { ActorScope } from "./actor-scope";
import { readGuidanceView, type GuidanceView } from "./performance-guidance";
import {
	readComparedVideos,
	summarizePerformance,
	type PerformanceSummary,
} from "./performance-summary";
import { workspaceService } from "./workspace.service";

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

export class PerformanceService {
	/**
	 * The Workspace's "What worked" summary. Every video is compared at the same
	 * age, by its 7-day capture, grouped by the clip facts frozen when it was
	 * first tracked (see `readComparedVideos`).
	 */
	async whatWorked(scope: ActorScope): Promise<PerformanceSummary> {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		const { measured, waiting } = await readComparedVideos(requirePrisma(), scope.workspaceId);
		return summarizePerformance(measured, waiting);
	}

	/** The guidance Narriflow currently has for this Workspace, and whether it is used. */
	async guidance(scope: ActorScope): Promise<GuidanceView> {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
		return readGuidanceView(requirePrisma(), scope.workspaceId);
	}

	/** "Use my performance data to pick clips". Owners and admins change it. */
	async setGuidanceEnabled(scope: ActorScope, enabled: boolean): Promise<void> {
		await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "workspace.manage");
		await requirePrisma().workspace.update({
			where: { id: scope.workspaceId },
			data: { usePerformanceGuidance: enabled },
		});
	}
}

export const performanceService = new PerformanceService();
