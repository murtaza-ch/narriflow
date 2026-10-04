import { expect, test } from "bun:test";
import { boundedMcpRequest, mcpCorsResponse, rejectMcpOrigin, requireMcpMutationLimiter } from "./mcp-http";

const origins = ["https://app.example", "http://localhost:3000"];
test("origin admission includes scheme and port and refuses malformed origin values", () => {
  for (const origin of ["http://app.example", "https://app.example:444", "null", "https://app.example/path", "https://app.example,https://evil.example"]) {
    const request = new Request("https://app.example/mcp", { headers: { origin } });
    expect(rejectMcpOrigin(request, origins)?.status).toBe(403);
    expect(mcpCorsResponse(new Response(), request, origins).headers.has("Access-Control-Allow-Origin")).toBe(false);
  }
  expect(rejectMcpOrigin(new Request("https://app.example/mcp", { headers: { origin: "https://app.example" } }), origins)).toBeNull();
});
test("accepted CORS preserves Vary and private caching", () => {
  const response = mcpCorsResponse(new Response(null, { headers: { Vary: "Accept", "Cache-Control": "private, max-age=0" } }),
    new Request("https://app.example/mcp", { headers: { origin: "https://app.example" } }), origins);
  expect(response.headers.get("Vary")).toBe("Accept, Origin");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
  expect(response.headers.get("Cache-Control")).toBe("private, max-age=0");
});
test("bounds actual streamed bytes even without content length or with a false small length", async () => {
  for (const headers of [{}, { "Content-Length": "1" }]) {
    const request = new Request("https://app.example/mcp", { method: "POST", body: "x".repeat(65), headers });
    const result = await boundedMcpRequest(request, 64);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  }
});
test("preserves allowed request bytes and routing headers", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const result = await boundedMcpRequest(new Request("https://app.example/mcp", { method: "POST", body, headers: { "MCP-Method": "tools/list" } }));
  expect(result).toBeInstanceOf(Request);
  expect(await (result as Request).text()).toBe(body);
  expect((result as Request).headers.get("MCP-Method")).toBe("tools/list");
});
test("unavailable limiter pauses new writes with a typed retryable failure", () => {
  expect(() => requireMcpMutationLimiter({ allowed: true, availability: "unavailable", remaining: 300, limit: 300 }))
    .toThrow(expect.objectContaining({ code: "mcp_mutations_unavailable", kind: "unavailable", retryAfterSeconds: 5 }));
  expect(() => requireMcpMutationLimiter({ allowed: true, availability: "available", remaining: 299, limit: 300 })).not.toThrow();
});
