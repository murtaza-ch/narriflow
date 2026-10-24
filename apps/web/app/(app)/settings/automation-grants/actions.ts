"use server";

import { revalidatePath } from "next/cache";
import { standingGrants } from "@narriflow/services";
import { createStandingGrantSchema, renewStandingGrantSchema, standingGrantReferenceSchema } from "@narriflow/validators";
import { executeWorkspaceActionWithInput } from "@/lib/authenticated-request-action";

// Only Owners and Admins hold workspace.manage, which is what grants need.
function refresh() {
	revalidatePath("/settings/automation-grants");
	revalidatePath("/autopilot");
}

export async function createStandingGrantAction(input: unknown) {
	return executeWorkspaceActionWithInput("workspace.manage", input, createStandingGrantSchema, async (actor, parsed) => {
		await standingGrants.create(actor, parsed);
		refresh();
	});
}

/** Restates a grant's terms and starts a new revision; it also resumes a paused or expired grant. */
export async function renewStandingGrantAction(input: unknown) {
	return executeWorkspaceActionWithInput("workspace.manage", input, renewStandingGrantSchema, async (actor, parsed) => {
		await standingGrants.renew(actor, parsed);
		refresh();
	});
}

export async function pauseStandingGrantAction(grantId: string) {
	return executeWorkspaceActionWithInput("workspace.manage", { grantId }, standingGrantReferenceSchema, async (actor, parsed) => {
		await standingGrants.pause(actor, parsed.grantId);
		refresh();
	});
}

export async function revokeStandingGrantAction(grantId: string) {
	return executeWorkspaceActionWithInput("workspace.manage", { grantId }, standingGrantReferenceSchema, async (actor, parsed) => {
		await standingGrants.revoke(actor, parsed.grantId);
		refresh();
	});
}
