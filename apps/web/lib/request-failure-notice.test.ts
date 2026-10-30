import { describe, expect, test } from "bun:test";
import { capabilityDeniedHref, requestFailureNotice } from "./request-failure-notice";

const notice = (query: string) => requestFailureNotice(new URLSearchParams(query));

describe("request failure notice", () => {
  test("says nothing without a failure", () => {
    expect(notice("")).toBeNull();
    expect(notice("from=upload")).toBeNull();
  });

  test("names what the member could not do, per origin", () => {
    expect(notice("requestFailure=capability_denied&from=upload")).toBe(
      "You need editor access to upload videos. Ask a workspace admin to change your role.",
    );
    expect(notice("requestFailure=capability_denied&from=studio")).toContain("edit clips in the Studio");
    expect(notice("requestFailure=capability_denied&from=brand-kit")).toContain("brand profiles");
    expect(notice("requestFailure=capability_denied&from=api-settings")).toContain("API keys");
  });

  test("an unknown origin or failure code reads generically, never echoing the URL", () => {
    const generic = "You don't have access to that page with your current role. Ask a workspace admin to change your role.";
    expect(notice("requestFailure=capability_denied")).toBe(generic);
    expect(notice("requestFailure=capability_denied&from=<script>")).toBe(generic);
    expect(notice("requestFailure=something_else&from=upload&requestId=req-1")).toBe(generic);
    expect(notice("requestFailure=capability_denied&from=constructor")).toBe(generic);
  });

  test("redirects carry their origin", () => {
    expect(capabilityDeniedHref("upload")).toBe("/home?requestFailure=capability_denied&from=upload");
  });
});
