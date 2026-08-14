import { describe, expect, test } from "bun:test";
import {
  WorkflowFailure,
  workflowFailureFromUnknown,
  workflowHttpFailureDisposition,
} from "./workflow-run-lifecycle";

describe("Workflow Failure disposition", () => {
  test("classifies permanent and transient HTTP responses at the provider boundary", () => {
    expect(workflowHttpFailureDisposition(400)).toBe("permanent");
    expect(workflowHttpFailureDisposition(401)).toBe("permanent");
    expect(workflowHttpFailureDisposition(429)).toBe("retryable");
    expect(workflowHttpFailureDisposition(503)).toBe("retryable");
  });

  test("preserves a disposition already assigned by the failure source", () => {
    const source = new WorkflowFailure(
      "invalid_provider_request",
      "permanent",
      "Provider rejected the request",
    );
    expect(workflowFailureFromUnknown(source)).toBe(source);
  });
});
