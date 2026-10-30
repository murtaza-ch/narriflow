import { describe, expect, test } from "bun:test";
import { storedLanguageCode } from "./project.service";

describe("storedLanguageCode", () => {
  test("automatic detection is stored as null", () => {
    for (const value of ["auto", "AUTO", " ", "", null, undefined]) {
      expect(storedLanguageCode(value)).toBeNull();
    }
  });

  test("provider codes are normalised and unknown codes never reach the worker", () => {
    expect(storedLanguageCode("EN_US")).toBe("en");
    expect(storedLanguageCode("jw")).toBe("jv");
    expect(storedLanguageCode("tl")).toBe("fil");
    expect(storedLanguageCode("es")).toBe("es");
    expect(storedLanguageCode("yi")).toBeNull();
    expect(storedLanguageCode("klingon")).toBeNull();
    expect(storedLanguageCode(42)).toBeNull();
  });
});
