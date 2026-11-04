import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createInventoryApp } from "../../test-app";

const secret = "SECRET-TOKEN";
const legacy = {
  "csp-report": {
    "document-uri": `https://app.example.com/projects/p1?token=${secret}#frag`,
    "blocked-uri": `https://cdn.evil.example/x.js?key=${secret}`,
    "effective-directive": "script-src-elem",
    "original-policy": `default-src 'self'; ${secret}`,
  },
};
const modern = [
  { type: "csp-violation", url: "https://app.example.com/a", body: {
    documentURL: `https://app.example.com/library?q=${secret}`, blockedURL: "inline", effectiveDirective: "script-src",
  } },
  { type: "deprecation", body: {} },
];

let warn: ReturnType<typeof spyOn> | undefined;
afterEach(() => warn?.mockRestore());

function post(app: ReturnType<typeof createInventoryApp>, type: string, body: string, headers: Record<string, string> = {}) {
  return app.request("/api/csp-report", { method: "POST", headers: { "content-type": type, ...headers }, body });
}
const logged = () => (warn?.mock.calls ?? []).map((call: unknown[]) => String(call[0]));

describe("POST /api/csp-report", () => {
  test("accepts the legacy format and logs only host, directive and path", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await post(createInventoryApp(), "application/csp-report", JSON.stringify(legacy));
    expect(response.status).toBe(204);
    const lines = logged().filter((line) => line.includes("csp_violation_reported"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      level: "warn", message: "csp_violation_reported",
      blockedHost: "cdn.evil.example", directive: "script-src-elem", documentPath: "/projects/p1",
    });
    expect(logged().join("\n")).not.toContain(secret);
  });

  test("accepts reports+json and ignores other report types", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await post(createInventoryApp(), "application/reports+json; charset=utf-8", JSON.stringify(modern));
    expect(response.status).toBe(204);
    const lines = logged().filter((line) => line.includes("csp_violation_reported"));
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { level: "warn", message: "csp_violation_reported", blockedHost: "inline", directive: "script-src", documentPath: "/library" },
    ]);
    expect(logged().join("\n")).not.toContain(secret);
  });

  test("always answers 204: oversized, malformed, wrong type and rate limited", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createInventoryApp();
    const big = JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(70 * 1024) } });
    expect((await post(app, "application/csp-report", big)).status).toBe(204);
    expect((await post(app, "application/csp-report", "{not json")).status).toBe(204);
    expect((await post(app, "text/plain", JSON.stringify(legacy))).status).toBe(204);
    const limited = createInventoryApp({ admin: { rateLimit: async () => ({ allowed: false }) as never } });
    expect((await post(limited, "application/csp-report", JSON.stringify(legacy))).status).toBe(204);
    const broken = createInventoryApp({ admin: { rateLimit: async () => { throw new Error("down"); } } });
    expect((await post(broken, "application/csp-report", JSON.stringify(legacy))).status).toBe(204);
    expect(logged().filter((line) => line.includes("csp_violation_reported"))).toHaveLength(0);
  });

  test("answers the Reporting API preflight", async () => {
    const response = await createInventoryApp().request("/api/csp-report", {
      method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });
});
