import { describe, expect, test } from "bun:test";
import { ApiError } from "@narriflow/api-client/core";
import { decideResume, decideResumeFailure, deniedImportDestination } from "./resume-decision";

const failure = (code: string, status: number) => new ApiError({ code, message: code, status });

describe("upload resume decisions", () => {
  test("a finished Configure opens the Project, an empty draft restarts", () => {
    expect(decideResume("p1", { outcome: "open_project" })).toEqual({ kind: "open_project", projectId: "p1" });
    expect(decideResume("p1", { outcome: "restart" })).toEqual({ kind: "restart" });
  });

  test("a concealed or malformed Project restarts, as the old redirect to /upload did", () => {
    expect(decideResumeFailure(failure("project_not_found", 404))).toEqual({ kind: "restart" });
    expect(decideResumeFailure(failure("invalid_input", 400))).toEqual({ kind: "restart" });
  });

  test("another Workspace's Project asks for a switch instead of redirecting", () => {
    expect(decideResumeFailure(failure("active_workspace_mismatch", 409))).toEqual({ kind: "workspace_mismatch" });
  });

  test("other failures are shown rather than discarding the saved draft", () => {
    const error = failure("internal_error", 500);
    expect(decideResumeFailure(error)).toEqual({ kind: "failed", error });
  });
});

describe("import access", () => {
  test("a role that cannot import leaves for Home with the access notice, as the old page did", () => {
    expect(deniedImportDestination(failure("capability_denied", 403))).toBe("/home?requestFailure=capability_denied&from=upload");
  });

  test("failures that can recover stay on the page", () => {
    expect(deniedImportDestination(failure("internal_error", 500))).toBeNull();
    expect(deniedImportDestination(new Error("offline"))).toBeNull();
    expect(deniedImportDestination(null)).toBeNull();
  });
});
