const fs = require("node:fs");
const path = require("node:path");

const output = path.resolve(".next/output");
const root = path.resolve("../..");
const missing = new Set();
let count = 0;
for (const file of fs.readdirSync(output, { recursive: true })) {
  if (!file.endsWith(".vc-config.json")) continue;
  const config = JSON.parse(fs.readFileSync(path.join(output, file), "utf8"));
  for (const mappedPath of Object.values(config.filePathMap ?? {})) {
    count++;
    if (!fs.existsSync(path.resolve(root, mappedPath))) missing.add(mappedPath);
  }
}
console.log(`Vercel output: ${count} file mappings, ${missing.size} missing files`);
for (const file of missing) console.error(`MISSING: ${file}`);
if (missing.size) process.exitCode = 1;
