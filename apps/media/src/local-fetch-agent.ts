import { readFile, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { signExecutionRequest } from "@narriflow/services/execution-signature";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { localFetchDeviceConfigurationSchema } from "@narriflow/validators/api/local-fetch";

/** The laptop opens outbound connections only. Native jobs receive this one
 * device session on stdin and independently acquire their database owner. */
async function main() {
  const args = process.argv.slice(2), sessionFlag = args.indexOf("--session"), commandFlag = args.indexOf("--native-command-json");
  if (sessionFlag < 0 || !args[sessionFlag + 1]) throw new Error("local_fetch_session_file_required");
  const sessionFile = args[sessionFlag + 1]!;
  await chmod(sessionFile, 0o600);
  const text = await readFile(sessionFile, "utf8");
  if (text.length > 8192) throw new Error("local_fetch_session_invalid");
  const configuration = localFetchDeviceConfigurationSchema.parse(JSON.parse(text)), origin = new URL(configuration.apiOrigin);
  if (origin.protocol !== "https:" || origin.origin !== configuration.apiOrigin) throw new Error("local_fetch_session_invalid");
  const command: string[] = commandFlag < 0
    ? ["docker", "run", "--rm", "-i", "--init", "--cpus=2", "--memory=4g", "--pids-limit=512", "narriflow-media:local-fetch", "python", "-m", "narriflow_media.local_agent"]
    : JSON.parse(args[commandFlag + 1] ?? "null");
  if (!Array.isArray(command) || !command.length || command.length > 64 || command.some(part => typeof part !== "string" || !part || part.length > 2048)) throw new Error("local_fetch_command_invalid");
  const nativeEnvironment = { PATH: process.env.PATH, HOME: process.env.HOME, LIMA_HOME: process.env.LIMA_HOME, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
  // A connected socket means the pinned native runtime is ready, rather than
  // merely proving that the WebSocket client can run on the laptop.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, [...command.slice(1), "--verify-runtime"], { detached: true, stdio: ["ignore", "pipe", "ignore"], env: nativeEnvironment });
    let output = "";
    const timer = setTimeout(() => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } reject(new Error("local_fetch_runtime_unavailable")); }, 90000);
    child.stdout?.on("data", chunk => { output += String(chunk); if (output.length > 8192) { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } } });
    child.once("error", () => { clearTimeout(timer); reject(new Error("local_fetch_runtime_unavailable")); });
    child.once("exit", code => { clearTimeout(timer); try { if (code !== 0 || JSON.parse(output).fingerprint !== configuration.toolchainFingerprint) throw new Error(); resolve(); } catch { reject(new Error("local_fetch_runtime_unavailable")); } });
  });
  const key = new Uint8Array(Buffer.from(configuration.key, "base64url"));
  let stopping = false, socket: WebSocket | undefined;
  const children = new Map<string, ReturnType<typeof spawn>>();
  const pending = new Map<string, { reference: ExecutionDispatchReference; attemptToken: string }>();
  function stopChildren() {
    pending.clear();
    for (const child of children.values()) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Process already exited. */ }
      const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already reaped. */ } }, 5000);
      timer.unref(); child.once("exit", () => clearTimeout(timer));
    }
  }
  function drain() {
    while (!stopping && socket?.readyState === WebSocket.OPEN && children.size < 2 && pending.size) {
      const [identity, invocation] = pending.entries().next().value!;
      pending.delete(identity);
      const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: ["pipe", "ignore", "ignore"],
        env: nativeEnvironment });
      children.set(identity, child);
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify({ configuration, invocation }));
      child.once("error", () => { children.delete(identity); console.warn(JSON.stringify({ level: "warn", message: "local_fetch_native_start_failed" })); drain(); });
      child.once("exit", code => { children.delete(identity); console.log(JSON.stringify({ level: "info", message: "local_fetch_native_ended", code })); drain(); });
    }
  }
  function stop() { stopping = true; socket?.close(); stopChildren(); }
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  async function post(path: string, input: unknown) {
    if (Date.now() >= configuration.expiresAt) throw new Error("local_fetch_session_expired");
    const body = new TextEncoder().encode(JSON.stringify(input));
    const signature = await signExecutionRequest({ keyId: configuration.keyId, key, audience: "dev-device", method: "POST", target: path,
      body, timestamp: Math.floor(Date.now() / 1000), deliveryId: crypto.randomUUID() });
    const response = await fetch(new URL(path, origin), { method: "POST", body, headers: { "Content-Type": "application/json",
      "X-Local-Fetch-Session": configuration.sessionToken, "X-Execution-Signature": JSON.stringify(signature) }, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error([401, 403].includes(response.status) ? "local_fetch_session_expired" : "local_fetch_transport_unavailable");
    const result = await response.text();
    if (result.length > 8192) throw new Error("local_fetch_response_invalid");
    return JSON.parse(result) as { ticket?: string; nextCursor?: string | null };
  }
  while (!stopping && Date.now() < configuration.expiresAt) {
    try {
      const ticket = await post("/api/dev-device/connect-ticket", {});
      if (!ticket.ticket || !/^[a-f0-9-]{36}$/.test(ticket.ticket)) throw new Error("local_fetch_response_invalid");
      const target = new URL(`/api/dev-device/${configuration.workspaceId}/socket`, origin);
      target.protocol = "wss:"; target.searchParams.set("ticket", ticket.ticket);
      socket = new WebSocket(target, { headers: { Origin: configuration.apiOrigin }, maxPayload: 8192, handshakeTimeout: 15000, followRedirects: false });
      let lastPong = Date.now();
      await new Promise<void>((resolve, reject) => {
        const active = socket!;
        const ping = setInterval(() => {
          if (Date.now() >= configuration.expiresAt || Date.now() - lastPong > 45000) { active.terminate(); return; }
          if (active.readyState === WebSocket.OPEN) active.send("ping");
        }, 15000);
        active.once("close", () => { clearInterval(ping); stopChildren(); resolve(); });
        active.once("error", () => { clearInterval(ping); active.terminate(); reject(new Error("local_fetch_connection_lost")); });
        active.on("message", raw => {
          try {
            const text = raw.toString();
            if (text === "pong") { lastPong = Date.now(); return; }
            const message = JSON.parse(text);
            if (message.type === "connected") {
              console.log(JSON.stringify({ level: "info", message: "local_fetch_connected", expiresAt: configuration.expiresAt }));
              // One authorized pass on connect, paged by a durable dispatch ID.
              void (async () => {
                let after: string | null = null;
                do { const page = await post("/api/dev-device/reconcile", after ? { after } : {}); after = page.nextCursor ?? null; } while (after && !stopping && active.readyState === WebSocket.OPEN);
              })().catch(() => active.terminate());
              return;
            }
            if (message.type !== "fetch" || Object.keys(message).sort().join(",") !== "attemptToken,reference,type") throw new Error();
            const reference = executionDispatchReferenceSchema.parse(message.reference);
            if (reference.kind !== "local_fetch" || reference.subject.kind !== "ingest_job" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(message.attemptToken)) throw new Error();
            const identity = `${reference.dispatchId}:${message.attemptToken}`;
            if (children.has(identity) || pending.has(identity)) return;
            if (pending.size >= 100) { console.warn(JSON.stringify({ level: "warn", message: "local_fetch_queue_full" })); return; }
            pending.set(identity, { reference, attemptToken: message.attemptToken });
            drain();
          } catch { active.close(1008, "Invalid fetch reference"); }
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message === "local_fetch_session_expired") break;
      console.warn(JSON.stringify({ level: "warn", message: "local_fetch_reconnecting" }));
    }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 3000));
  }
  stop();
}

// Keep the CLI alive through asynchronous signing after the native verifier exits.
await main().catch(() => { console.error("local_fetch_start_failed"); process.exitCode = 1; });
