import { describe, expect, test } from "bun:test";
import { parseOrigin, parseOriginList } from "./origins";

describe("API origins", () => {
  test("accepts exact origins only", () => {
    expect(parseOrigin("https://app.example.com")).toBe("https://app.example.com");
    expect(parseOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of [
      "https://app.example.com/",
      "https://app.example.com/path",
      "https://*.example.com",
      "https://user:pw@app.example.com",
      "https://app.example.com?x=1",
      "ftp://app.example.com",
      "app.example.com",
      "",
    ]) {
      expect(parseOrigin(bad)).toBeNull();
    }
  });

  test("parses lists, deduplicates and names the setting without echoing values", () => {
    expect(parseOriginList(" https://a.example , https://a.example,http://localhost:3000,", "X")).toEqual([
      "https://a.example",
      "http://localhost:3000",
    ]);
    expect(parseOriginList(undefined, "X")).toEqual([]);
    expect(() => parseOriginList("https://a.example/secret-path", "CORS_ALLOWED_ORIGINS")).toThrow(
      "CORS_ALLOWED_ORIGINS entries must be full origins without a path or wildcard",
    );
  });
});
