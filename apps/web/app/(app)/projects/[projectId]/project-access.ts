import {
	workspaceAllowsCapability,
	type WorkspaceAccessRole,
	type WorkspaceAccessStatus,
} from "@narriflow/validators";

/** Why this member can only view and download the project, and the next step. */
export interface ProjectViewOnlyNote {
	message: string;
	/** Label for the owner's link to billing; `null` when someone else must act. */
	billingAction: string | null;
}

/**
 * `null` when the member can edit, render and publish (every project mutation
 * needs `content.edit` or a capability granted with it). Otherwise the one
 * reason the project page shows instead of controls that would be refused.
 */
export function projectViewOnlyNote(context: {
	role: WorkspaceAccessRole;
	status: WorkspaceAccessStatus;
}): ProjectViewOnlyNote | null {
	if (workspaceAllowsCapability(context, "content.edit")) return null;
	const owner = context.role === "owner";
	if (context.status === "pending_payment") {
		return owner
			? { message: "Finish billing setup to edit, render or publish this project.", billingAction: "Complete setup" }
			: { message: "This workspace's billing setup isn't finished. Ask the workspace owner to complete it.", billingAction: null };
	}
	if (context.status === "restricted") {
		return owner
			? { message: "This workspace is restricted, so projects are view-only. Update billing to keep working.", billingAction: "Manage billing" }
			: { message: "This workspace is restricted, so projects are view-only. Ask the workspace owner to update billing.", billingAction: null };
	}
	return {
		message: "You have view access. Ask a workspace owner or admin to make you an editor to change, render or publish clips.",
		billingAction: null,
	};
}
