import { getPrismaClient } from "@narriflow/db/client";
import { createPerformanceGuidance } from "./performance-guidance";


/** The worker's production Performance Guidance, on the shared database. */
export function getPerformanceGuidance() {
		const prisma = getPrismaClient();
		if (!prisma) throw new Error("Database client unavailable");
		return createPerformanceGuidance({ prisma });
}
