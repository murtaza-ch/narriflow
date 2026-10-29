import { describe, expect, test } from "bun:test";
import config from "./next.config";

async function cspFor(source: string): Promise<string> {
  const rules = await (config as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }).headers();
  const rule = rules.find((entry) => entry.source === source && entry.headers.some((h) => h.key === "Content-Security-Policy"));
  const value = rule?.headers.find((h) => h.key === "Content-Security-Policy")?.value;
  if (!value) throw new Error(`no CSP for ${source}`);
  return value;
}

describe("page Content-Security-Policy", () => {
  test("the review CSP allows Clerk's blob worker", async () => {
    expect(await cspFor("/review/:path*")).toContain("worker-src 'self' blob:");
  });
});
