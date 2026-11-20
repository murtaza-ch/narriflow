import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { REQUEST_DELAY_MS, USER_AGENT } from "./config";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function log(message: string, context: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: "info", message, ...context }));
}

/**
 * An error as a log-safe string: Prisma's `code` and message, with every given
 * secret and any connection URL removed, so a failed connect never prints the
 * database credentials.
 */
export function describeError(error: unknown, secrets: readonly (string | undefined)[] = []): string {
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? `${(error as { code: string }).code}: ` : "";
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  return `${code}${text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[redacted-url]")}`;
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** Write via a temp file so an interrupted run never leaves a half-written JSON. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, path);
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

let lastRequestAt = 0;

/** Sequential, spaced requests: one request at a time with a fixed pause between them. */
export async function politeFetch(url: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const wait = lastRequestAt + REQUEST_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} for ${url}`);
        await sleep(attempt * 4000);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      await sleep(attempt * 4000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
}

/** Download to `<path>.part` then rename. A non-empty existing file is a cache hit. */
export async function download(url: string, path: string, init: RequestInit = {}): Promise<{ bytes: number; cached: boolean }> {
  const existing = await fileSize(path);
  if (existing > 0) return { bytes: existing, cached: true };
  const response = await politeFetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength === 0) throw new Error(`Empty response for ${url}`);
  await mkdir(dirname(path), { recursive: true });
  const part = `${path}.part`;
  await writeFile(part, body);
  await rename(part, path);
  return { bytes: body.byteLength, cached: false };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function flag(name: string): boolean {
  return process.argv.includes(name);
}

export function utcNow(): string {
  return new Date().toISOString();
}

export const FETCH_STATE_VERSION = 1;

/** What fetch recorded per source: the audit trail build copies into the manifest. */
export interface FetchState {
  version: number;
  incompetech?: {
    retrievedAt: string;
    piecesUrl: string;
    files: Record<string, { url: string; bytes: number; retrievedAt: string }>;
  };
  freepd?: {
    retrievedAt: string;
    files: Record<string, { url: string; bytes: number; retrievedAt: string }>;
  };
  kenney?: {
    packs: Record<string, { url: string; retrievedAt: string; bytes: number; licenseText: string }>;
  };
  bigsoundbank?: {
    sounds: Record<string, { pageUrl: string; fileUrl: string; retrievedAt: string; bytes: number; licenseLine: string }>;
    rejected: Record<string, string>;
  };
  failures: Array<{ source: string; item: string; reason: string }>;
}
