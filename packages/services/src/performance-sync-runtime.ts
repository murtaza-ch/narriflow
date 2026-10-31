import { getPrismaClient } from "@narriflow/db/client";
import { createPerformanceSync } from "./performance-sync";
import { socialOAuthService } from "./social-oauth.service";


/** The worker's production performance sync, on the shared database. */
export function getPerformanceSync() {
		const prisma = getPrismaClient();
		if (!prisma) throw new Error("Database client unavailable");
		return createPerformanceSync({ prisma, fetch, accounts: socialOAuthService });
}
