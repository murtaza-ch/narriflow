import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

const worker = await unstable_dev(fileURLToPath(new URL("./gates/artifact-storage-probe.ts", import.meta.url)), {
  config: fileURLToPath(new URL("./gates/wrangler.artifact-storage-probe.jsonc", import.meta.url)),
  local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0, persist: false, logLevel: "error",
  experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
});
try {
  const response = await worker.fetch("/");
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as { passed: number };
  assert.equal(result.passed, 3);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { await worker.stop(); }
