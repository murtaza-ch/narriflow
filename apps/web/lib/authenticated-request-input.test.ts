import { describe, expect, test } from "bun:test";
import { parseAuthenticatedJsonBody } from "./authenticated-request-input";

describe("authenticated JSON input", () => {
  test("treats an absent optional body as an empty strict object", () => {
    expect(parseAuthenticatedJsonBody("", true)).toEqual({});
    expect(parseAuthenticatedJsonBody("  \n", true)).toEqual({});
  });

  test("keeps malformed optional JSON distinguishable from an absent body", () => {
    expect(parseAuthenticatedJsonBody("{broken", true)).toBeNull();
    expect(parseAuthenticatedJsonBody("", false)).toBeNull();
  });
});
