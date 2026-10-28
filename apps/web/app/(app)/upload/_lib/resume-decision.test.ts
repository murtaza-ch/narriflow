import { describe, expect, test } from "bun:test";
import { ApiError } from "@narriflow/api-client/core";
import { decideResume, decideResumeFailure } from "./resume-decision";

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
