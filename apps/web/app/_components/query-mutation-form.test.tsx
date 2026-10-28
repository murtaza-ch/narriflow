import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { ApiError, CLIENT_ERROR_CODES } from "@narriflow/api-client";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiErrorNotice, apiErrorMessage, apiErrorSupportId } from "./query-mutation-form";

const failure = (code: string, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
  new ApiError({ code, message: "Server wording", status: 400, requestId: "req_123", ...extra });

describe("API failure wording", () => {
  test("is chosen by the stable code, not the message", () => {
    expect(apiErrorMessage(failure("authentication_required", { status: 401 }), "Fallback")).toContain("Your session ended");
    expect(apiErrorMessage(failure("active_workspace_mismatch", { status: 409, details: { workspaceName: "Team" } }), "Fallback")).toBe(
      "Switch to Team before trying again.",
    );
    expect(apiErrorMessage(failure("something_new"), "Fallback")).toBe("Fallback Support reference: req_123.");
  });

  test("stays silent when the person has moved on and tells an offline person so", () => {
    expect(apiErrorMessage(failure(CLIENT_ERROR_CODES.scopeChanged, { status: 0 }), "Fallback")).toBeNull();
    expect(apiErrorMessage(failure(CLIENT_ERROR_CODES.network, { status: 0 }), "Fallback")).toContain("offline");
  });

  test("an unexpected non-API error uses the fallback", () => {
    expect(apiErrorMessage(new Error("boom"), "Fallback")).toBe("Fallback");
    expect(apiErrorSupportId(new Error("boom"))).toBeNull();
  });

  test("the alert quotes the Support ID", () => {
    const html = renderToStaticMarkup(
      <ChakraProvider value={system}>
        <ApiErrorNotice error={failure("workspace_restricted", { status: 403, details: { ownerCanResolve: false } })} fallback="Fallback" />
      </ChakraProvider>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Support ID: req_123");
  });
});
