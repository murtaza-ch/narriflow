import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Guards the web/API split. The web app is a client of the API: it may not
 * import backend packages, run server actions, expose backend route handlers or
 * ship backend module names and secret variable names in its client bundle.
 * Biome's noRestrictedImports catches the common case while editing; this
 * script also follows relative paths and dependency manifests, and scans the
 * built client chunks when a build exists (`--bundle` makes the build mandatory).
 */

export const BACKEND_PACKAGES = [
  "@narriflow/services",
  "@narriflow/db",
  "@narriflow/auth",
  "@narriflow/mcp-core",
  "@narriflow/email",
  "@narriflow/api",
] as const;

/** Dependencies the web app no longer needs: they belong to the API or the worker. */
export const BACKEND_DEPENDENCIES = [
  ...BACKEND_PACKAGES,
  "@prisma/client",
  "@prisma/adapter-pg",
  "pg",
  "@node-rs/argon2",
  "@ffprobe-installer/ffprobe",
  "ioredis",
  "svix",
  "stripe",
  "@hono/zod-openapi",
  "@hono/zod-validator",
  "@modelcontextprotocol/server",
  "next-safe-action",
] as const;

/** Repository directories web code must never reach by relative path. */
const BACKEND_DIRECTORIES = [
  "apps/api",
  "apps/worker",
  "apps/mcp",
  "packages/services",
  "packages/db",
  "packages/auth",
  "packages/mcp-core",
  "packages/email",
] as const;

/** Route handlers that stay in web: docs content (search, Markdown, llms text). */
const ALLOWED_ROUTE_HANDLERS = [
  "app/api/docs/search/route.ts",
  "app/(docs)/docs-markdown/[[...slug]]/route.ts",
  "app/(docs)/docs-og/[[...slug]]/route.tsx",
  "app/(docs)/docs/llms-full.txt/route.ts",
  "app/(docs)/docs/llms.txt/route.ts",
] as const;

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", ".turbo", "dist"]);
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bmock\.module\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1/g;

export interface Violation {
  rule: string;
  file: string;
  detail: string;
}

export function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(join(directory, entry.name));
      } else if (SOURCE_FILE.test(entry.name)) {
        files.push(join(directory, entry.name));
      }
    }
  };
  if (existsSync(root)) walk(root);
  return files;
}

export function importSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[2] as string);
}

function isBackendPackage(specifier: string): boolean {
  return BACKEND_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function reachesBackendDirectory(specifier: string, file: string, repositoryRoot: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = relative(repositoryRoot, resolve(dirname(file), specifier)).split(sep).join("/");
  return BACKEND_DIRECTORIES.some((directory) => target === directory || target.startsWith(`${directory}/`));
}

export function checkImports(webRoot: string, repositoryRoot: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of sourceFiles(webRoot)) {
    const source = readFileSync(file, "utf8");
    const shown = relative(repositoryRoot, file);
    for (const specifier of importSpecifiers(source)) {
      if (isBackendPackage(specifier) || reachesBackendDirectory(specifier, file, repositoryRoot)) {
        violations.push({ rule: "backend-import", file: shown, detail: specifier });
      }
    }
    if (/^\s*(["'])use server\1/m.test(source)) {
      violations.push({ rule: "use-server", file: shown, detail: "Server Actions are gone; call the API" });
    }
  }
  return violations;
}

export function checkRouteHandlers(webRoot: string, repositoryRoot: string): Violation[] {
  const allowed = new Set<string>(ALLOWED_ROUTE_HANDLERS);
  return sourceFiles(join(webRoot, "app"))
    .filter((file) => /(?:^|[\\/])route\.[cm]?[jt]sx?$/.test(file))
    .map((file) => ({ file, relativeToWeb: relative(webRoot, file).split(sep).join("/") }))
    .filter(({ relativeToWeb }) => !allowed.has(relativeToWeb))
    .map(({ file, relativeToWeb }) => ({
      rule: "route-handler",
      file: relative(repositoryRoot, file),
      detail: `${relativeToWeb} is a backend route handler; only docs content handlers may live in web`,
    }));
}

export function checkManifest(webRoot: string, repositoryRoot: string): Violation[] {
  const path = join(webRoot, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  return BACKEND_DEPENDENCIES.filter((name) => name in declared).map((name) => ({
    rule: "backend-dependency",
    file: relative(repositoryRoot, path),
    detail: name,
  }));
}

/**
 * Names the web app may legitimately mention in browser code: Clerk's SDK reads
 * its own settings by name (the secret itself is never bundled) and Next
 * replaces NODE_ENV.
 */
const ALLOWED_VARIABLE_NAMES = new Set(["NODE_ENV", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY"]);

/** Variable names the API and worker read: they must not appear in code sent to browsers. */
export function serverVariableNames(repositoryRoot: string): string[] {
  const names = new Set<string>();
  for (const example of ["apps/api/.env.example", "apps/worker/.env.example", "packages/db/.env.example"]) {
    const path = join(repositoryRoot, example);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^\s*#?\s*([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*=/.exec(line);
      const name = match?.[1];
      if (name && !name.startsWith("NEXT_PUBLIC_") && name.length >= 8 && !ALLOWED_VARIABLE_NAMES.has(name)) names.add(name);
    }
  }
  return [...names].sort();
}

/** Backend module names that mean server code was bundled for the browser. */
export const SERVER_MODULE_MARKERS = [
  "@prisma/client",
  "@narriflow/services",
  "@narriflow/db",
  "@narriflow/mcp-core",
  "@node-rs/argon2",
  "ioredis",
  "svix",
  "PrismaClient",
] as const;

export function scanClientBundle(staticRoot: string, serverNames: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  const markers = [...SERVER_MODULE_MARKERS, ...serverNames];
  // A variable name only counts as a whole token: NEXT_PUBLIC_GOOGLE_CLIENT_ID is not GOOGLE_CLIENT_ID.
  const mentions = (text: string, marker: string): boolean => {
    for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
      const before = text[at - 1];
      const after = text[at + marker.length];
      if (!/[A-Za-z0-9_]/.test(before ?? "") && !/[A-Za-z0-9_]/.test(after ?? "")) return true;
    }
    return false;
  };
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.(?:js|css|html|json|map)$/.test(entry.name) && statSync(path).size < 40_000_000) {
        const text = readFileSync(path, "utf8");
        for (const marker of markers) {
          if (mentions(text, marker)) violations.push({ rule: "client-bundle", file: path, detail: marker });
        }
      }
    }
  };
  walk(staticRoot);
  return violations;
}

export function runChecks(repositoryRoot: string, options: { requireBundle?: boolean } = {}): Violation[] {
  const webRoot = join(repositoryRoot, "apps/web");
  const violations = [
    ...checkImports(webRoot, repositoryRoot),
    ...checkRouteHandlers(webRoot, repositoryRoot),
    ...checkManifest(webRoot, repositoryRoot),
  ];
  const staticRoot = join(webRoot, ".next/static");
  if (existsSync(staticRoot)) {
    violations.push(...scanClientBundle(staticRoot, serverVariableNames(repositoryRoot)));
  } else if (options.requireBundle) {
    violations.push({ rule: "client-bundle", file: "apps/web/.next/static", detail: "no build to scan; run the web build first" });
  }
  return violations;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const violations = runChecks(root, { requireBundle: process.argv.includes("--bundle") });
  if (violations.length > 0) {
    console.error("Web/API split check failed:");
    for (const violation of violations) console.error(`- [${violation.rule}] ${violation.file}: ${violation.detail}`);
    process.exitCode = 1;
  } else {
    const scanned = existsSync(join(root, "apps/web/.next/static")) ? "client bundle scanned" : "no build present, bundle not scanned";
    console.log(`Web/API split check passed: no backend imports, Server Actions or route handlers; ${scanned}.`);
  }
}
