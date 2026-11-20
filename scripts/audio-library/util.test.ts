import { describe, expect, test } from "bun:test";
import { describeError } from "./util";

describe("describeError", () => {
  const url = "postgresql://owner:s3cretpass@db.example.test/neondb?sslmode=require";

  test("keeps Prisma's code and drops the connection string and its password", () => {
    const error = Object.assign(new Error(`Can't reach ${url} (password s3cretpass)`), { code: "P1001" });
    const text = describeError(error, [url, "s3cretpass"]);
    expect(text).toStartWith("P1001: ");
    expect(text).not.toContain("s3cretpass");
    expect(text).not.toContain("db.example.test");
  });

  test("redacts any URL even when no secret is passed", () => {
    expect(describeError(new Error(`connect failed for ${url}.`))).not.toContain("owner");
  });

  test("passes plain messages through", () => {
    expect(describeError(new Error("Invalid manifest"))).toBe("Invalid manifest");
    expect(describeError("boom")).toBe("boom");
  });
});
