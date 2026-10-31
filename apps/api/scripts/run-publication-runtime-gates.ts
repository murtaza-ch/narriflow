import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

const worker = await unstable_dev(fileURLToPath(new URL("../../../packages/services/scripts/gates/publication-checkpoint-probe.ts", import.meta.url)), {
  config: fileURLToPath(new URL("./gates/wrangler.publication-runtime-probe.jsonc", import.meta.url)),
  local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0, persist: false, logLevel: "error",
  experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
});
try {
  const result = await worker.fetch("/");
  assert.equal(result.status, 200, await result.clone().text());
  const report = await result.json() as { passed: number };
  assert.equal(report.passed, 4);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally { await worker.stop(); }
