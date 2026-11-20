import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./config";

/** Parses KEY=VALUE lines. Values are never logged. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, separator).trim()] = value;
  }
  return out;
}

export function readEnvFile(relativePath: string): Record<string, string> {
  const path = join(REPO_ROOT, relativePath);
  if (!existsSync(path)) throw new Error(`${relativePath} is missing`);
  return parseEnvFile(readFileSync(path, "utf8"));
}

export function requireKeys(env: Record<string, string>, keys: readonly string[], source: string): void {
  const missing = keys.filter((key) => !env[key]?.trim());
  if (missing.length > 0) throw new Error(`${source} is missing ${missing.join(", ")}`);
}

/**
 * This script lives outside every workspace package, so it cannot resolve their
 * dependencies by name. Resolve them from the package that owns them, the same
 * way Bun would for a file inside it, so the module instance is shared.
 */
export function resolveFrom(specifier: string, packageSrcDir: string): string {
  const bun = (globalThis as { Bun?: { resolveSync(specifier: string, parent: string): string } }).Bun;
  if (!bun) throw new Error("Run this script with Bun");
  return bun.resolveSync(specifier, join(REPO_ROOT, packageSrcDir));
}
