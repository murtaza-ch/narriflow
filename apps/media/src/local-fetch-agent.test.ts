import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function fixture(status = 401, fingerprint = "a".repeat(64)) {
  const directory = await mkdtemp(join(tmpdir(), "narriflow-agent-lifecycle-"));
  const session = join(directory, "invalid-offline-session.json");
  const native = join(directory, "native.ts");
  const nativeMarker = join(directory, "native-ran");
  const preload = join(directory, "offline-transport.ts");
  const key = new Uint8Array(32).fill(7);
  await writeFile(session, JSON.stringify({
    version: 1, apiOrigin: "https://offline.invalid", sessionToken: "invalid-offline-token",
    keyId: "00000000-0000-4000-8000-000000000001", key: Buffer.from(key).toString("base64url"),
    workspaceId: "00000000-0000-4000-8000-000000000002", expiresAt: Date.now() + 120_000,
    toolchainFingerprint: "a".repeat(64),
  }), { mode: 0o600 });
  await writeFile(native, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(nativeMarker)}, "verified", { mode: 0o600 });
console.log(JSON.stringify({ fingerprint: ${JSON.stringify(fingerprint)} }));
`, { mode: 0o600 });
  const signer = fileURLToPath(new URL("../../../packages/services/src/execution-signature.ts", import.meta.url));
  await writeFile(preload, `import { verifyExecutionRequest } from ${JSON.stringify(signer)};
globalThis.fetch = async (target, init) => {
  const path = new URL(String(target)).pathname;
  if (path !== "/api/dev-device/connect-ticket" || init?.method !== "POST") throw new Error("offline_request_scope_changed");
  const headers = new Headers(init.headers);
  const body = new Uint8Array(init.body as Uint8Array);
  await verifyExecutionRequest({ signature: JSON.parse(headers.get("X-Execution-Signature")!),
    keyRing: new Map([["00000000-0000-4000-8000-000000000001", new Uint8Array(32).fill(7)]]),
    audience: "dev-device", method: "POST", target: path, body, nowSeconds: Math.floor(Date.now() / 1000) });
  if (new TextDecoder().decode(body) !== "{}" || headers.get("X-Local-Fetch-Session") !== "invalid-offline-token") throw new Error("offline_request_changed");
  console.log(JSON.stringify({ message: "offline_ticket_request", signatureVerified: true }));
  return new Response("{}", { status: ${status} });
};
`, { mode: 0o600 });
  return { directory, session, native, nativeMarker, preload };
}

function launch(f: Awaited<ReturnType<typeof fixture>>) {
  const child = spawn(process.execPath, ["--no-env-file", "--preload", f.preload,
    fileURLToPath(new URL("./local-fetch-agent.ts", import.meta.url)), "--session", f.session,
    "--native-command-json", JSON.stringify([process.execPath, "--no-env-file", f.native])], {
    env: { PATH: process.env.PATH, HOME: f.directory }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { child, ended, output: () => ({ stdout, stderr }) };
}

test("CLI awaits startup through native verifier exit and real signing before its first request", async () => {
  const f = await fixture();
  const p = launch(f);
  try {
    expect(await p.ended).toBe(0);
    expect(await readFile(f.nativeMarker, "utf8")).toBe("verified");
    expect(p.output().stdout).toContain('"message":"offline_ticket_request","signatureVerified":true');
    expect(p.output().stderr).toBe("");
  } finally {
    p.child.kill("SIGKILL");
    await p.ended;
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("CLI reports a failed native preflight without making a request", async () => {
  const f = await fixture(401, "b".repeat(64));
  const p = launch(f);
  try {
    expect(await p.ended).toBe(1);
    expect(p.output().stdout).not.toContain("offline_ticket_request");
    expect(p.output().stderr.trim()).toBe("local_fetch_start_failed");
  } finally {
    p.child.kill("SIGKILL");
    await p.ended;
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("CLI remains alive after a retryable request failure and honors SIGTERM", async () => {
  const f = await fixture(503);
  const p = launch(f);
  try {
    const marker = await new Promise<string>(resolve => {
      const timer = setTimeout(() => resolve("request_not_reached"), 5000);
      const observe = () => {
        if (p.output().stdout.includes("offline_ticket_request")) { clearTimeout(timer); resolve("request_reached"); }
      };
      p.child.stdout.on("data", observe);
      p.ended.then(() => { clearTimeout(timer); resolve("premature_exit"); });
    });
    expect(marker).toBe("request_reached");
    p.child.kill("SIGTERM");
    expect(await p.ended).toBe(0);
    expect(p.output().stderr).toContain('"message":"local_fetch_reconnecting"');
    expect(p.output().stderr).not.toContain("invalid-offline-token");
  } finally {
    p.child.kill("SIGKILL");
    await p.ended;
    await rm(f.directory, { recursive: true, force: true });
  }
}, 10_000);

