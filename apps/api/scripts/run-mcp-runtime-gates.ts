import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

const settingsPath = process.env.MCP_GATE_DATABASE_ENV;
if (!settingsPath) throw new Error("MCP_GATE_DATABASE_ENV must identify an isolated gate database env file");
const settings = Object.fromEntries(readFileSync(settingsPath, "utf8").split("\n").filter((line) => line && !line.startsWith("#")).map((line) => {
  const at = line.indexOf("=");
  return [line.slice(0, at), line.slice(at + 1).replace(/^["']|["']$/g, "")];
}));
const connectionString = settings.SERVERLESS_TEST_DATABASE_URL ?? settings.DIRECT_URL;
if (!connectionString || new URL(connectionString).hostname !== "ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech") throw new Error("MCP gate requires the isolated cutover database host");
const worker = await unstable_dev(fileURLToPath(new URL("./gates/mcp-runtime-probe.ts", import.meta.url)), {
  config: fileURLToPath(new URL("./gates/wrangler.mcp-runtime-probe.jsonc", import.meta.url)),
  local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0, persist: false, logLevel: "error",
  vars: { HYPERDRIVE: { connectionString }, FIXTURE_ID: "isolated-sql" },
  experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
});
const version = "2026-07-28";
const meta = { "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientInfo": { name: "scope-gate", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
const checks: string[] = [];
function rpc(method: string, params: Record<string, unknown>) {
  return worker.fetch("/mcp", { method: "POST", headers: { "content-type": "application/json", "MCP-Protocol-Version": version, "MCP-Method": method, ...(typeof params.name === "string" ? { "MCP-Name": params.name } : {}), ...(typeof params.uri === "string" ? { "MCP-Name": params.uri } : {}), ...(typeof params.taskId === "string" ? { "MCP-Name": params.taskId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: "gate", method, params: { ...params, _meta: meta } }) });
}
try {
  const response = await rpc("tools/call", { name: "query", arguments: {} });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.deepEqual(await (await worker.fetch("/stats")).json(), { created: 0, disposed: 0, queries: 0 });
  checks.push("mcp_headers_before_sql");
  const stream = await response.text();
  assert.match(stream, /query-started/);
  assert.match(stream, /42:isolated-sql/);
  assert.deepEqual(await (await worker.fetch("/stats")).json(), { created: 1, disposed: 1, queries: 1 });
  checks.push("mcp_streamed_tool_real_sql_disposed");
  const resource = await rpc("resources/read", { uri: "gate://query" });
  assert.match(await resource.text(), /42:isolated-sql/);
  assert.deepEqual(await (await worker.fetch("/stats")).json(), { created: 2, disposed: 2, queries: 2 });
  checks.push("mcp_resource_real_sql_disposed");
  const task = await rpc("tasks/get", { taskId: "fixed-gate-task" });
  assert.match(await task.text(), /42:isolated-sql/);
  assert.deepEqual(await (await worker.fetch("/stats")).json(), { created: 3, disposed: 3, queries: 3 });
  checks.push("mcp_task_real_sql_disposed");
  const idle = await rpc("subscriptions/listen", { notifications: {} });
  assert.match(idle.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = idle.body!.getReader();
  await reader.read();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await (await worker.fetch("/stats")).json(), { created: 3, disposed: 3, queries: 3 });
  await reader.cancel();
  checks.push("mcp_idle_subscription_zero_sql");
  process.stdout.write(`${JSON.stringify({ runtime: "workerd", target: "isolated-direct-neon", checks, passed: checks.length })}\n`);
} finally { await worker.stop(); }
