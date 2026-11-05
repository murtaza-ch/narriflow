import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { describeFailure, logFailure } from "./log-failure";

afterEach(() => { (console.warn as unknown as { mockRestore?: () => void }).mockRestore?.(); });

describe("logFailure", () => {
  test("a multi-line message cannot smuggle text past redaction through the stack", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    logFailure("failed", new Error("first line\nat sam@example.com said token=supersecretvalue"));
    const output = String(warn.mock.calls[0]?.[0]);
    warn.mockRestore();
    expect(output).not.toContain("sam@example.com");
    expect(output).not.toContain("supersecretvalue");
  });

  test("records name, code, frames and the cause chain with secrets redacted", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const root = Object.assign(new Error("connect failed https://db.example/x?token=abc123 for jane@example.com"), { code: "ECONNRESET" });
    const top = new Error("session bootstrap failed", { cause: root });
    logFailure("unexpected_request_failure", top, { requestId: "r1" });
    const line = JSON.parse(warn.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ level: "error", message: "unexpected_request_failure", requestId: "r1", error: { name: "Error", message: "session bootstrap failed" } });
    expect(line.error.stack.length).toBeGreaterThan(0);
    expect(line.error.stack.length).toBeLessThanOrEqual(5);
    expect(line.error.causes[0]).toMatchObject({ name: "Error", code: "ECONNRESET" });
    const text = JSON.stringify(line);
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("jane@example.com");
  });

  test("bounds the message, keeps UUIDs and survives non-errors", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const long = describeFailure(new Error(`${id} ${"x".repeat(1000)}`));
    expect(long.message!.length).toBeLessThanOrEqual(300);
    expect(long.message).toContain(id);
    expect(describeFailure("boom")).toEqual({ name: "string" });
    expect(describeFailure(undefined)).toEqual({ name: "undefined" });
  });

  test("strips connection-string credentials and key=value secrets", () => {
    const { message } = describeFailure(new Error("password=hunter2 postgres://user:pw@db/x secret: s3cr3t"));
    expect(message).not.toMatch(/hunter2|user:pw|s3cr3t/);
  });

  test("strips bearer and key-shaped tokens", () => {
    const { message } = describeFailure(new Error(`401 Bearer eyJhbGciOi.payload.sig and key ${["sk", "live", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_")}`));
    expect(message).not.toContain("eyJhbGciOi");
    expect(message).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  test("hides a bearer credential even behind an Authorization header, and basic credentials", () => {
    const { message } = describeFailure(new Error("Authorization: Bearer abc123 then Authorization: Basic dXNlcjpwYXNz"));
    expect(message).not.toMatch(/abc123|dXNlcjpwYXNz/);
    expect(message).toContain("Authorization");
  });

  test("hides JSON and camelCase secret fields however short the value", () => {
    const { message } = describeFailure(new Error('{"access_token":"short","refresh_token": "r1"} accessToken=abc clientSecret=xyz1'));
    expect(message).not.toMatch(/short|"r1"|=abc|xyz1/);
  });

  test("slices before any replace: a 200 KB run without spaces finishes in milliseconds", () => {
    const started = performance.now();
    const hostile = ["a".repeat(200_000), `${"a-".repeat(100_000)}@`, "a.".repeat(100_000), `${"x".repeat(100_000)}://${"y".repeat(100_000)}`];
    for (const text of hostile) expect(describeFailure(new Error(text)).message!.length).toBeLessThanOrEqual(300);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("a secret inside the first 300 characters is hidden even after a long prefix is trimmed", () => {
    const { message } = describeFailure(new Error(`${"filler ".repeat(20)}password=hunter2 ${"tail ".repeat(500)}`));
    expect(message).not.toContain("hunter2");
  });
});
