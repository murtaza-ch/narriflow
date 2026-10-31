import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import WebSocket from "ws";
import { unstable_dev } from "wrangler";

const concurrencies = process.env.PROBE_CONCURRENCY ? process.env.PROBE_CONCURRENCY.split(",").map(Number) : [1, 2, 4, 6];
assert(concurrencies.every(value => Number.isSafeInteger(value) && value >= 1 && value <= 6));
const directory = await mkdtemp("/tmp/narriflow-selection-memory-");
execFileSync("bun", [fileURLToPath(new URL("./gates/build-selection-memory-fixture.ts", import.meta.url)), directory]);
const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
const inputBytes = await readFile(join(directory, "input.json"));
const objects = new Map<string, { bytes: Buffer; etag: string; sha256: string }>();
let received = 0;
const pending: Array<() => void> = [];
const providerReply = await readFile(join(directory, "provider.json"), "utf8");
const content = JSON.parse(providerReply).output[0].content[0].text as string;
const fixture = createServer(async (request, response) => {
  const url = new URL(request.url!, "http://fixture");
  if (url.pathname === "/metadata") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(metadata)); return; }
  if (url.pathname === "/provider") {
    for await (const _chunk of request) { /* Consume the real Responses request body. */ }
    received++;
    pending.push(() => { response.writeHead(200, { "content-type": "application/json", "x-request-id": "synthetic-memory-provider" }); response.end(providerReply); });
    return;
  }
  if (!url.pathname.startsWith("/private/")) { response.writeHead(404); response.end(); return; }
  const key = decodeURIComponent(url.pathname.slice("/private/".length));
  if (request.method === "PUT") {
    if (request.headers["if-none-match"] !== "*") { response.writeHead(400); response.end(); return; }
    if (objects.has(key)) { response.writeHead(412, { "content-type": "application/xml" }); response.end("<Error><Code>PreconditionFailed</Code></Error>"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), sha256 = createHash("sha256").update(bytes).digest("hex"), etag = `"${createHash("md5").update(bytes).digest("hex")}"`;
    assert.equal(request.headers["x-amz-meta-selection-sha256"], sha256);
    assert(bytes.length <= 1048576);
    objects.set(key, { bytes, etag, sha256 }); response.writeHead(200, { etag }); response.end(); return;
  }
  const object = objects.get(key);
  if (!object) { response.writeHead(404, { "content-type": "application/xml" }); response.end("<Error><Code>NoSuchKey</Code></Error>"); return; }
  if (request.method === "GET" && (request.headers["if-match"] !== object.etag || request.headers.range !== `bytes=0-${object.bytes.length - 1}`)) { response.writeHead(412); response.end(); return; }
  response.writeHead(request.method === "GET" ? 206 : 200, { "content-type": "application/json", "content-length": object.bytes.length, etag: object.etag,
    "x-amz-meta-selection-sha256": object.sha256, ...(request.method === "GET" ? { "content-range": `bytes 0-${object.bytes.length - 1}/${object.bytes.length}` } : {}) });
  response.end(request.method === "HEAD" ? undefined : object.bytes);
});
fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
async function freePort() { const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
function workerdVersion() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).trim().split("\n").map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); return match ? { pid: Number(match[1]), parent: Number(match[2]), command: match[3]! } : null;
  }).filter(Boolean) as Array<{ pid: number; parent: number; command: string }>;
  const children = new Set([process.pid]); for (let pass = 0; pass < 8; pass++) for (const row of rows) if (children.has(row.parent)) children.add(row.pid);
  const executable = rows.find(row => children.has(row.pid) && row.command.endsWith("workerd"))?.command;
  assert(executable, "This process must own the measured workerd"); return execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
}
async function inspector(port: number) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ title: string; webSocketDebuggerUrl: string }>;
  const target = targets.find(value => value.title.includes("selection-memory")) ?? targets[0]; assert(target);
  const socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, "open");
  const contexts: Array<{ id: number; name: string }> = [], requests = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>(); let nextId = 0;
  socket.on("message", data => { const message = JSON.parse(String(data)); if (message.method === "Runtime.executionContextCreated") contexts.push(message.params.context);
    const request = requests.get(message.id); if (!request) return; requests.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result); });
  return { target: { title: target.title }, contexts, call(method: string, params: Record<string, unknown> = {}) { const id = ++nextId; return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }, close() { socket.close(); } };
}
const results: unknown[] = [];
try {
  for (const concurrency of concurrencies) {
    received = 0; pending.length = 0; objects.clear(); objects.set(metadata.inputKey, { bytes: inputBytes, etag: '"synthetic-input"', sha256: metadata.inputHash });
    const inspectorPort = await freePort();
    const worker = await unstable_dev(fileURLToPath(new URL("./gates/selection-memory-probe.ts", import.meta.url)), { config: fileURLToPath(new URL("./gates/wrangler.selection-memory-probe.jsonc", import.meta.url)),
      local: true, ip: "127.0.0.1", port: 0, inspectorPort, persist: false, logLevel: "error", vars: { FIXTURE_ORIGIN: fixtureOrigin, CONCURRENCY: String(concurrency) },
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false } });
    let debuggerClient: Awaited<ReturnType<typeof inspector>> | null = null;
    try {
      assert.equal((await worker.fetch("/__warmup")).status, 200);
      debuggerClient = await inspector(inspectorPort); await debuggerClient.call("Runtime.enable");
      const marker = await debuggerClient.call("Runtime.evaluate", { expression: "globalThis.__selectionMemoryProbe", contextId: debuggerClient.contexts[0]?.id, returnByValue: true }) as { result?: { value?: unknown } };
      assert.equal(marker.result?.value, "narriflow-selection-memory-probe");
      const beforeHeap = await debuggerClient.call("Runtime.getHeapUsage"), samples: unknown[] = [];
      let finished = false, heldAt: number | null = null, releasedAt: number | null = null, afterHeldGc: unknown;
      const started = performance.now();
      const request = worker.fetch("/").then(async response => ({ status: response.status, body: await response.json() })).finally(() => { finished = true; });
      while (!finished && performance.now() - started < 20000) {
        samples.push({ atMs: Math.round(performance.now() - started), received, heap: await debuggerClient.call("Runtime.getHeapUsage") });
        if (received === concurrency) {
          heldAt ??= performance.now();
          if (performance.now() - heldAt >= 1000 && pending.length) {
            await debuggerClient.call("HeapProfiler.collectGarbage"); afterHeldGc = await debuggerClient.call("Runtime.getHeapUsage");
            releasedAt = performance.now(); for (const release of pending.splice(0)) release();
          }
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      for (const release of pending.splice(0)) release();
      const response = await request;
      const afterHeap = await debuggerClient.call("Runtime.getHeapUsage");
      assert.equal(received, concurrency); assert.equal(response.status, 200);
      const body = response.body as { calls: number; outcomes: Array<{ kind: string; outcome: string }> };
      assert.equal(body.calls, concurrency); assert(body.outcomes.every(outcome => outcome.kind === "complete" && outcome.outcome === "completed"));
      const result = { concurrency, ...response, sourceSeconds: metadata.sourceSeconds, words: metadata.words, utterances: metadata.utterances, privateInputBytes: metadata.inputBytes,
        syntheticProviderContentBytes: Buffer.byteLength(content), syntheticProviderResponseBytes: Buffer.byteLength(providerReply), inspectorMarkerVerified: true, inspectorTarget: debuggerClient.target,
        workerdVersion: workerdVersion(), providerAllRequestsHeldMs: releasedAt !== null && heldAt !== null ? Math.round(releasedAt - heldAt) : null,
        beforeHeap, afterHeldGc, afterHeap, wallMs: Math.round(performance.now() - started), samples };
      results.push(result); process.stdout.write(`${JSON.stringify({ concurrency, privateInputBytes: metadata.inputBytes, sampleCount: samples.length, beforeHeap, afterHeldGc, afterHeap, status: response.status })}\n`);
    } finally { for (const release of pending.splice(0)) release(); debuggerClient?.close(); await worker.stop(); }
  }
} finally {
  await new Promise<void>(resolve => fixture.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  await writeFile(process.env.PROBE_OUTPUT ?? "/tmp/narriflow-selection-memory.json", JSON.stringify({ runtime: "local-workerd", configuredCapsUnchanged: true, localSuccessDoesNotEnforceEdge128MiBLimit: true,
    sampledHeapIsNotExactPeak: true, domainDatabasePortsSynthetic: true, actualPrivateStorageAndProviderAdapters: true, minimumSyntheticProviderHoldMs: 1000, providerFetchBudgetMs: 90000,
    externalProviderRequests: 0, databaseRequests: 0, noEdgeDeployPerformed: true, nodeVersion: process.versions.node, results }, null, 2) + "\n");
}
