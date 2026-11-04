import { describe, expect, test } from "bun:test";
import { bearerCredential, isUuid } from "./identifiers";

describe("identifiers", () => {
  test("isUuid accepts only canonical UUIDs", () => {
    expect(isUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    for (const value of ["", "not-a-uuid", "123e4567e89b12d3a456426614174000", "123e4567-e89b-12d3-a456-42661417400g", undefined, 7]) expect(isUuid(value)).toBe(false);
  });

  test("bearerCredential reads one credential and refuses merged or malformed values", () => {
    expect(bearerCredential("Bearer abc.def")).toBe("abc.def");
    expect(bearerCredential("bearer abc")).toBe("abc");
    for (const value of ["Bearer a, Bearer b", "Bearer a b", "Basic abc", "Bearer ", "", null, undefined]) expect(bearerCredential(value)).toBeNull();
  });
});
