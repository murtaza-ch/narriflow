import { describe, expect, test } from "bun:test";
import { ApiError } from "@narriflow/api-client";
import { developerFailureMessage } from "./failure-message";

const refusal = (code: string, status: number, message = "Specific sentence.") => new ApiError({ code, status, message });

describe("developerFailureMessage", () => {
  test("shows the server's specific sentence for an ordinary refusal", () => {
    expect(developerFailureMessage(refusal("webhook_exists", 409, "This workspace already has a webhook for this URL."), "fallback")).toBe(
      "This workspace already has a webhook for this URL.",
    );
    expect(developerFailureMessage(refusal("credential_already_issued", 409, "Already created."), "fallback")).toBe("Already created.");
  });

  test("keeps the shared recovery wording for sign-in and a server fault", () => {
    expect(developerFailureMessage(refusal("authentication_required", 401), "fallback")).toContain("Sign in again");
    expect(developerFailureMessage(refusal("internal_error", 500, "boom"), "The key could not be created.")).toContain("The key could not be created.");
  });
});
