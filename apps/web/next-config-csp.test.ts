import { describe, expect, test } from "bun:test";
import config from "./next.config";

async function cspFor(source: string): Promise<string> {
  const rules = await (config as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }).headers();
  const rule = rules.find((entry) => entry.source === source && entry.headers.some((h) => h.key === "Content-Security-Policy"));
  const value = rule?.headers.find((h) => h.key === "Content-Security-Policy")?.value;
  if (!value) throw new Error(`no CSP for ${source}`);
  return value;
}

async function reportOnlyCspFor(source: string): Promise<string> {
  const rules = await (config as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }).headers();
  for (const rule of rules.filter((entry) => entry.source === source)) {
    const value = rule.headers.find((h) => h.key === "Content-Security-Policy-Report-Only")?.value;
    if (value) return value;
  }
  throw new Error(`no report-only CSP for ${source}`);
}

describe("page Content-Security-Policy", () => {
  test("the app CSP admits the YouTube preview player on the upload Configure step", async () => {
    const csp = await reportOnlyCspFor("/:path*");
    expect(csp).toMatch(/script-src [^;]*https:\/\/www\.youtube\.com/);
    expect(csp).toMatch(/frame-src [^;]*https:\/\/www\.youtube-nocookie\.com/);
  });

  test("the review CSP allows Clerk's blob worker", async () => {
    expect(await cspFor("/review/:path*")).toContain("worker-src 'self' blob:");
  });
});
