import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  // The policy admits Clerk's own hosts and no third-party beacon, so Clerk's
  // browser telemetry is switched off instead of allowed.
  test("Clerk browser telemetry is disabled rather than admitted by the CSP", async () => {
    expect(readFileSync(new URL("./app/layout.tsx", import.meta.url), "utf8")).toMatch(/<ClerkProvider\s+telemetry=\{false\}/);
    expect(await reportOnlyCspFor("/:path*")).not.toContain("clerk-telemetry.com");
  });

  test("the Report-Only policy reports to the API and enforces nothing new", async () => {
    const rules = await (config as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }).headers();
    const headers = rules.filter((entry) => entry.source === "/:path*").flatMap((entry) => entry.headers);
    const csp = await reportOnlyCspFor("/:path*");
    const origin = process.env.NEXT_PUBLIC_API_URL?.trim() ? new URL(process.env.NEXT_PUBLIC_API_URL).origin : "http://localhost:4000";
    expect(csp).toContain(`report-uri ${origin}/api/csp-report`);
    expect(csp).toContain("report-to csp-endpoint");
    expect(headers.find((h) => h.key === "Reporting-Endpoints")?.value).toBe(`csp-endpoint="${origin}/api/csp-report"`);
    expect(headers.find((h) => h.key === "Content-Security-Policy")?.value).toBe("frame-ancestors 'none';");
    expect(csp).not.toContain("nonce-");
  });

  test("a production Clerk host is admitted only when the publishable key provides it", async () => {
    expect(await reportOnlyCspFor("/:path*")).not.toContain("clerk.narriflow.example");
    const previous = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_live_${Buffer.from("clerk.narriflow.example$").toString("base64")}`;
    try {
      const live = (await import("./next.config?clerk-live")).default as typeof config;
      const rules = await (live as unknown as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }).headers();
      const csp = rules.filter((entry) => entry.source === "/:path*").flatMap((entry) => entry.headers)
        .find((h) => h.key === "Content-Security-Policy-Report-Only")?.value ?? "";
      for (const directive of ["script-src", "connect-src", "frame-src"]) {
        expect(csp).toMatch(new RegExp(`${directive} [^;]*https://clerk\\.narriflow\\.example`));
      }
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
      else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = previous;
    }
  });
});
