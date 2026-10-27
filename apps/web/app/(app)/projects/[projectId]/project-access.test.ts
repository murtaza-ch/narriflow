import { expect, test } from "bun:test";
import { projectViewOnlyNote } from "./project-access";

test("members who can edit see no view-only note", () => {
	for (const role of ["owner", "admin", "editor"] as const) {
		expect(projectViewOnlyNote({ role, status: "active" })).toBeNull();
	}
});

test("a viewer is told whom to ask, never offered billing", () => {
	const note = projectViewOnlyNote({ role: "viewer", status: "active" });
	expect(note?.message).toContain("Ask a workspace owner or admin");
	expect(note?.billingAction).toBeNull();
});

test("an inactive workspace sends its owner to billing and everyone else to the owner", () => {
	for (const status of ["pending_payment", "restricted"] as const) {
		expect(projectViewOnlyNote({ role: "owner", status })?.billingAction).not.toBeNull();
		for (const role of ["admin", "editor", "viewer"] as const) {
			const note = projectViewOnlyNote({ role, status });
			expect(note?.billingAction).toBeNull();
			expect(note?.message).toContain("Ask the workspace owner");
		}
	}
});
