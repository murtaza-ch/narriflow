import { getPrismaClient } from "@narriflow/db/client";
import { createPerformanceGuidance } from "./performance-guidance";

let guidance: ReturnType<typeof createPerformanceGuidance> | null = null;

/** The worker's production Performance Guidance, on the shared database. */
export function getPerformanceGuidance() {
	if (!guidance) {
		const prisma = getPrismaClient();
		if (!prisma) throw new Error("Database client unavailable");
		guidance = createPerformanceGuidance({ prisma });
	}
	return guidance;
}
