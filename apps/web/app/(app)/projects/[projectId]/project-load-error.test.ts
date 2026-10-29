import { describe, expect, test } from "bun:test";
import { ApiError } from "@narriflow/api-client";
import { projectGateDestination } from "./project-load-error";

const projectId = "11111111-1111-4111-8111-111111111111";
const failure = (status: number, code: string, details?: Record<string, unknown>) =>
	new ApiError({ code, message: code, status, requestId: "req-1", details });

describe("Project gate destinations", () => {
	test("a Project in another Workspace offers the switch on the explorer, never switching by itself", () => {
		const to = projectGateDestination(
			failure(409, "active_workspace_mismatch", { workspaceId: "w-2", workspaceName: "Team & Co" }),
			projectId,
		);
		expect(to).toBe(
			`/projects?requestFailure=active_workspace_mismatch&workspaceId=w-2&workspaceName=Team%20%26%20Co&returnTo=${encodeURIComponent(`/projects/${projectId}`)}`,
		);
	});

	test("a paused Workspace sends the owner to billing and anyone else outside the shell", () => {
		expect(projectGateDestination(failure(403, "workspace_restricted", { ownerCanResolve: true }), projectId)).toBe(
			"/settings/billing?requestFailure=workspace_restricted&requestId=req-1",
		);
		expect(projectGateDestination(failure(403, "workspace_restricted", {}), projectId)).toBe(
			"/workspace-unavailable?requestFailure=workspace_restricted&requestId=req-1",
		);
	});

	test("a missing capability goes home; a missing Project and outages stay on the page", () => {
		expect(projectGateDestination(failure(403, "capability_denied"), projectId)).toBe(
			"/home?requestFailure=capability_denied&requestId=req-1",
		);
		expect(projectGateDestination(failure(404, "project_not_found"), projectId)).toBeNull();
		expect(projectGateDestination(failure(503, "authentication_unavailable"), projectId)).toBeNull();
	});
});
