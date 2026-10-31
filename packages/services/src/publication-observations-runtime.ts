import { getPrismaClient } from "@narriflow/db/client";
import { createPublicationObservations } from "./publication-observations";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { socialOAuthService } from "./social-oauth.service";
/** Fresh per Workflow step; no client or account token survives a durable wait. */
export function getPublicationObservations() {
	const database = getPrismaClient();
	if (!database)
		throw Error("Publication observations require a database scope");
	return createPublicationObservations({
		database,
		fetch,
		accounts: socialOAuthService,
		register: deliverExecutionDispatches,
	});
}
