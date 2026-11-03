import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const api = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const dependency = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = dependency("miniflare");
const { build } = dependency("esbuild");
const ts = require("typescript");
const config = ts.readConfigFile(join(api, "wrangler.jsonc"), ts.sys.readFile).config;
const alias = Object.fromEntries(Object.entries(config.alias).map(([name, value]) => [name, require.resolve(value as string)]));
const bundled = await build({ entryPoints: [join(api, "scripts/gates/progress-runtime-probe.ts")], bundle: true, format: "esm", platform: "browser", conditions: ["workerd", "worker"], external: ["cloudflare:workers", "node:*"], alias, write: false });
const key = randomBytes(32), origin = "https://web.narriflow.test", projectId = randomUUID();
const common = { compatibilityDate: "2026-10-30", compatibilityFlags: ["nodejs_compat", "disallow_importable_env"], modules: true, script: bundled.outputFiles[0].text,
  bindings: { API_ORIGIN: "https://api.narriflow.test", PROGRESS_CONNECT_KEY_ID: "gate", PROGRESS_CONNECT_KEYS_JSON: JSON.stringify({ gate: key.toString("base64url") }) } };
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
  { ...common, name: "local-progress", serviceBindings: { DEV_CLOUD: "cloud-progress" } },
  { ...common, name: "cloud-progress", durableObjects: { PROJECT_PROGRESS: { className: "ProjectProgress", useSQLite: true } } },
] }));
try {
  const authorizedAt = Date.now();
  const payload = { version: 1, actorUserId: "actor", workspaceId: "workspace", projectId, origin, audience: "https://api.narriflow.test/api/progress", authorizedAt, ticketExpiresAt: authorizedAt + 30000, subscriptionExpiresAt: authorizedAt + 60000, nonce: randomBytes(16).toString("hex") };
  const input = `progress1.gate.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const ticket = `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
  const connect = (token: string, browserOrigin = origin) => mf.dispatchFetch(`http://localhost:4000/api/progress/${projectId}?ticket=${token}`, { headers: { Upgrade: "websocket", Origin: browserOrigin } });
  const response = await connect(ticket);
  assert.equal(response.status, 101, "local middleware must preserve the remote WebSocket upgrade: " + (response.status === 101 ? "" : await response.text()));
  const socket = response.webSocket;
  assert.ok(socket);
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("progress connected frame missing")), 5000);
    socket.addEventListener("message", (event: { data: string }) => {
      const frame = JSON.parse(event.data);
      if (frame.type === "connected") { clearTimeout(timer); try { assert.equal(frame.projectId, projectId); resolve(); } catch (error) { reject(error); } }
    });
  });
  socket.accept(); await connected;
  assert.equal((await connect(ticket)).status, 409);
  assert.equal((await connect("invalid")).status, 401);
  assert.equal((await connect(ticket, "https://invalid.test")).status, 403);
  socket.close();
  console.log(JSON.stringify({ runtime: "workerd", passed: 4, checks: ["local_proxy_preserves_upgrade_and_connected_frame", "replay_refusal_preserved", "invalid_ticket_refusal_preserved", "wrong_origin_refusal_preserved"], postgresBindings: 0, externalProviderRequests: 0 }));
} finally { await mf.dispose(); }
