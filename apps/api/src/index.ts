import { getPrismaClient } from "@narriflow/db/client";
import { NATIVE_BODY_CAP_BYTES } from "./http/limits";
import { loadApiConfig } from "./config";
import { applyApiPoolDefaults, createProductionApp } from "./runtime";
import { createLifecycle, type ServerBindings, type ServerHandle } from "./server-hooks";

/** The slice of `Bun.serve` this entry uses. Bun's global types are not loaded: they clash with the services layer's DOM/Node typings. */
interface BunServer {
  port: number;
  stop(closeActiveConnections?: boolean): Promise<void>;
}
interface BunRuntime {
  serve(options: {
    port: number;
    hostname: string;
    idleTimeout: number;
    maxRequestBodySize: number;
    fetch(request: Request, server: ServerHandle): Response | Promise<Response>;
  }): BunServer;
}
const { Bun } = globalThis as unknown as { Bun: BunRuntime };

/** Railway sends SIGTERM and kills the container after its termination deadline; finish well before. */
const SHUTDOWN_DEADLINE_MS = 20_000;
/** Seconds of connection inactivity Bun tolerates. Above the slowest synchronous LLM route; SSE disables it per request. */
const IDLE_TIMEOUT_SECONDS = 120;

applyApiPoolDefaults();
const config = loadApiConfig();
const lifecycle = createLifecycle();
const app = createProductionApp(config, lifecycle);

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  idleTimeout: IDLE_TIMEOUT_SECONDS,
  // A hard bound above every route class, so ordinary oversize requests get the app's 413 envelope.
  maxRequestBodySize: NATIVE_BODY_CAP_BYTES,
  fetch: (request, bunServer) =>
    app.fetch(request, { server: bunServer, lifecycle } satisfies ServerBindings),
});

console.warn(
  JSON.stringify({
    level: "info",
    message: "api_listening",
    port: server.port,
    environment: config.nodeEnv,
  }),
);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(JSON.stringify({ level: "info", message: "api_draining", signal }));
  const forceExit = setTimeout(() => {
    console.warn(JSON.stringify({ level: "error", message: "api_drain_deadline_exceeded" }));
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  forceExit.unref();
  try {
    // Readiness fails first, open event streams close, then in-flight requests finish.
    await lifecycle.beginDrain();
    await server.stop();
    await getPrismaClient()?.$disconnect();
    // Redis connections belong to the services layer and close with the process.
    console.warn(JSON.stringify({ level: "info", message: "api_drained" }));
    process.exit(0);
  } catch {
    console.warn(JSON.stringify({ level: "error", message: "api_drain_failed" }));
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
