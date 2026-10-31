import { readFileSync, writeFileSync } from "node:fs";

interface BundleInput {
  imports?: Array<{ path: string; external?: boolean }>;
}
interface BundleMetadata {
  inputs: Record<string, BundleInput>;
  outputs: Record<string, {
    inputs?: Record<string, { bytesInOutput: number }>;
    imports?: Array<{ path: string; external?: boolean }>;
  }>;
}

const metafile = new URL("../dist/worker/bundle-meta.json", import.meta.url);
const metadata = JSON.parse(readFileSync(metafile, "utf8")) as BundleMetadata;
const emitted = new Map<string, number>();
const external = new Set<string>();
for (const [path, output] of Object.entries(metadata.outputs)) {
  if (!path.endsWith(".js")) continue;
  for (const [input, { bytesInOutput }] of Object.entries(output.inputs ?? {})) {
    if (bytesInOutput > 0) emitted.set(input, (emitted.get(input) ?? 0) + bytesInOutput);
  }
  for (const imported of output.imports ?? []) if (imported.external) external.add(imported.path);
}
const forbidden = ["ioredis", "@node-rs/argon2", "sharp", "fontkit", "@ffprobe-installer/ffprobe"];
const forbiddenPackages = forbidden.flatMap((name) => {
  const inputs = [...emitted.keys()].filter((path) => path.includes(`/node_modules/${name}/`));
  return inputs.length ? [{ name, inputs: inputs.length, emittedBytes: inputs.reduce((sum, path) => sum + (emitted.get(path) ?? 0), 0) }] : [];
});
const forbiddenNativeImport = /^node:(?:fs|child_process|dns|http|https|net|tls)(?:\/|$)/;
const nativeServiceModules = [...emitted.keys()].flatMap((path) => {
  if (!path.includes("/packages/services/src/")) return [];
  const imports = [...new Set((metadata.inputs[path]?.imports ?? [])
    .map((entry) => entry.path)
    .filter((name) => forbiddenNativeImport.test(name) && external.has(name)))];
  return imports.length ? [{ path, imports }] : [];
});
const obsoleteModules = [...emitted.keys()].filter((path) =>
  path.includes("/apps/worker/") || /@prisma\/client\/runtime\/(?:binary|library)/.test(path));
const passed = forbiddenPackages.length === 0 && nativeServiceModules.length === 0 && obsoleteModules.length === 0;
const report = { passed, forbiddenPackages, nativeServiceModules, obsoleteModules };
const reportIndex = process.argv.indexOf("--report");
if (reportIndex >= 0) {
  const reportPath = process.argv[reportIndex + 1];
  if (!reportPath) throw new Error("--report requires an output path");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.warn(JSON.stringify({ level: passed ? "info" : "error", message: "worker_bundle_import_audit", ...report }));
if (!passed) process.exitCode = 1;
