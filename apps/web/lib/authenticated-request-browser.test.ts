import { describe, expect, test } from "bun:test";
import {
  authenticatedRequestFailureMessage,
  authenticatedActionResultMessage,
  classifyAuthenticatedRequestFailure,
  isAuthenticatedActionFailure,
} from "./authenticated-request-browser";

describe("authenticated request browser recovery", () => {
  test("preserves a safe destination and rejects an external sign-in return", () => {
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "authentication_required" },
        "/projects/p1?tab=clips",
      ),
    ).toMatchObject({
      kind: "sign_in",
      preserveInput: true,
      returnDestination: "/projects/p1?tab=clips",
    });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "authentication_required" },
        "https://attacker.test/steal",
      ),
    ).toMatchObject({ returnDestination: "/home" });
  });

  test("keeps Workspace mismatch, validation, conflict, wait, and retry distinct", () => {
    expect(
      classifyAuthenticatedRequestFailure(
        {
          error: "active_workspace_mismatch",
          details: { workspaceId: "w2", workspaceName: "Team" },
        },
        "/home",
      ),
    ).toMatchObject({ kind: "switch_workspace", workspaceId: "w2" });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "invalid_input", issues: [{ path: ["title"] }] },
        "/home",
      ),
    ).toMatchObject({ kind: "correct_input", focusPath: ["title"] });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "revision_conflict" },
        "/home",
      ),
    ).toMatchObject({ kind: "refresh", preserveInput: true });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "rate_limited", retryAfterSeconds: 12.1 },
        "/home",
      ),
    ).toMatchObject({ kind: "wait", retryAfterSeconds: 13 });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "storage_unavailable" },
        "/home",
      ),
    ).toMatchObject({ kind: "retry", preserveInput: true });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "remote_fetch_timeout" },
        "/upload",
      ),
    ).toMatchObject({ kind: "retry", preserveInput: true });
  });

  test("recognizes only the discriminated serialized action failure", () => {
    expect(
      isAuthenticatedActionFailure({
        ok: false,
        error: "invalid_input",
        code: "invalid_input",
        message: "Check the fields.",
        requestId: "request-action-1",
      }),
    ).toBe(true);
    expect(isAuthenticatedActionFailure({ ok: true })).toBe(false);
    expect(isAuthenticatedActionFailure({ error: "invalid_input" })).toBe(false);
    expect(
      isAuthenticatedActionFailure({
        ok: false,
        error: "Could not save the Project.",
        errorCode: "project_save_failed",
        requestId: "request-domain-1",
      }),
    ).toBe(false);
    expect(
      authenticatedActionResultMessage(
        {
          ok: false,
          error: "Could not save the Project.",
          errorCode: "project_save_failed",
          requestId: "request-domain-1",
        },
        "Fallback",
      ),
    ).toBe("Could not save the Project.");
  });

  test("directs restricted owners to billing and other members to the owner", () => {
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "workspace_restricted", details: { ownerCanResolve: true } },
        "/home",
      ),
    ).toMatchObject({ kind: "billing" });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "workspace_restricted", details: { ownerCanResolve: false } },
        "/home",
      ),
    ).toMatchObject({ kind: "contact_owner" });
  });

  test("turns the shared recovery decision into safe actionable copy", () => {
    expect(
      authenticatedRequestFailureMessage(
        { error: "rate_limited", retryAfterSeconds: 4.2 },
        "/upload",
        "Upload failed.",
      ),
    ).toBe("Wait 5 seconds before trying again.");
    expect(
      authenticatedRequestFailureMessage(
        { error: "internal_error", requestId: "request-browser-1" },
        "/upload",
        "Upload failed.",
      ),
    ).toContain("request-browser-1");
  });
});
