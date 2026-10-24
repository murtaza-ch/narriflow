import { getPrismaClient } from "@narriflow/db/client";
import { createPerformanceSync } from "./performance-sync";
import { socialOAuthService } from "./social-oauth.service";

let sync: ReturnType<typeof createPerformanceSync> | null = null;

/** The worker's production performance sync, on the shared database. */
export function getPerformanceSync() {
	if (!sync) {
		const prisma = getPrismaClient();
		if (!prisma) throw new Error("Database client unavailable");
		sync = createPerformanceSync({ prisma, fetch, accounts: socialOAuthService });
	}
	return sync;
}
