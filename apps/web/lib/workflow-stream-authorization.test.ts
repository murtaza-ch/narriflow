import { describe, expect, test } from "bun:test";
import { parseWorkflowAuthorizationControl } from "./workflow-stream-authorization";

describe("workflow stream authorization control", () => {
  test("accepts only bounded safe control fields", () => {
    expect(
      parseWorkflowAuthorizationControl(
        JSON.stringify({
          error: "workspace_restricted",
          requestId: "request-1",
        }),
      ),
    ).toEqual({ error: "workspace_restricted", requestId: "request-1" });
    expect(parseWorkflowAuthorizationControl("not-json")).toBeNull();
    expect(
      parseWorkflowAuthorizationControl(
        JSON.stringify({ error: { private: true } }),
      ),
    ).toBeNull();
  });
});
