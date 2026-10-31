import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";

// This CLI owns process environment and files. Runtime database code only sees
// HYPERDRIVE; native jobs never receive either development database URL.
const api = fileURLToPath(new URL("..", import.meta.url)), configPath = join(api, "wrangler.jsonc");
const parsed = ts.readConfigFile(configPath, ts.sys.readFile);
if (parsed.error) throw new Error("Invalid Wrangler configuration");
const base = parsed.config;
const direct = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "");
const database = new URL(process.env.DATABASE_URL ?? direct.href);
if (!["postgres:", "postgresql:"].includes(direct.protocol) || direct.hostname.includes("-pooler.") ||
  direct.hostname !== database.hostname.replace("-pooler.", ".") || direct.pathname !== database.pathname) throw new Error("Development database URLs must select the same direct database");
if (!["localhost", "127.0.0.1", "::1"].includes(direct.hostname)) direct.searchParams.set("sslmode", "verify-full");

const names = [...(await readFile(join(api, ".dev.vars"), "utf8")).matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map(match => match[1]!);
const settings: Record<string, string> = {};
for (const name of names) if (!["DATABASE_URL", "DIRECT_URL"].includes(name) && process.env[name] !== undefined) settings[name] = process.env[name]!;
settings.APP_ENV = "development";
const temporary = await mkdtemp(join(tmpdir(), "narriflow-api-dev-"));
try {
  const require = createRequire(new URL("../package.json", import.meta.url));
  const aliases = Object.fromEntries(Object.entries(base.alias ?? {}).map(([name, value]) => [name, require.resolve(value as string)]));
  const local = { ...base, name: `${base.name}-local`, main: join(api, base.main), tsconfig: relative(temporary, join(api, "tsconfig.json")), alias: aliases,
    workers_dev: false, preview_urls: false, routes: [], triggers: {},
    r2_buckets: (base.r2_buckets ?? []).map((bucket: object) => ({ ...bucket, remote: true })),
    services: [...(base.services ?? []).filter((service: { binding: string }) => service.binding !== "DEV_CLOUD"),
      { binding: "DEV_CLOUD", service: base.name, entrypoint: "DevelopmentBindings", remote: true }],
  };
  const localConfig = join(temporary, "wrangler.json"), localSettings = join(temporary, "settings.env");
  await writeFile(localConfig, JSON.stringify(local), { mode: 0o600 });
  // --env-file is loaded as secret_text by Wrangler, so values are masked.
  await writeFile(localSettings, Object.entries(settings).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n"), { mode: 0o600 });
  // Wrangler normalizes tsconfig against cwd, then builds against the config
  // directory. Use the same directory for both and the installed pinned CLI.
  const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  const child = Bun.spawn(["node", wrangler, "dev", "--config", localConfig, "--env-file", localSettings, ...process.argv.slice(2)], {
    cwd: temporary, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env,
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: direct.href,
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false" },
  });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  process.exitCode = await child.exited;
} finally { await rm(temporary, { recursive: true, force: true }); }
