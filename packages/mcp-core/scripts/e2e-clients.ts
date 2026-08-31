import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { workspaceService } from "@narriflow/services";

import { getPrismaClient } from "../../db/src";
import {
  buildNarriflowMcpServer,
  NARRIFLOW_MCP_TOOL_NAMES,
} from "../src";

const repoRoot = resolve(import.meta.dir, "../../..");
const webRoot = join(repoRoot, "apps/web");
const stdioEntry = join(repoRoot, "apps/mcp/src/index.ts");
const expectedTools = [...NARRIFLOW_MCP_TOOL_NAMES];

function progress(message: string) {
  process.stdout.write(`[mcp-e2e] ${message}\n`);
}

function redact(value: string, secret: string) {
  return value.replaceAll(secret, "[redacted]");
}

async function snapshotFiles(paths: string[]) {
  return Promise.all(paths.map(async (path) => ({
    path,
    content: await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  })));
}

async function restoreFiles(snapshots: Awaited<ReturnType<typeof snapshotFiles>>) {
  await Promise.all(snapshots.map(({ path, content }) =>
    content === null ? rm(path, { force: true }) : writeFile(path, content)));
}

function clerkOAuthIssuer() {
  const configured = process.env.CLERK_OAUTH_ISSUER?.trim();
  if (configured) return new URL(configured).origin;
  const publishableKey =
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY;
  assert(publishableKey, "CLERK_OAUTH_ISSUER or a Clerk publishable key is required");
  const encoded = publishableKey.replace(/^pk_(?:test|live)_/, "");
  const frontendApi = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
  assert(frontendApi, "Could not derive the Clerk OAuth issuer");
  return new URL(`https://${frontendApi}`).origin;
}

async function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForServer(
  url: string,
  child: ChildProcess,
  diagnostics: () => string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Narriflow web exited with ${child.exitCode}: ${diagnostics().slice(-4_000)}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastStatus = response.status;
    } catch {
      // Expected while Next.js binds the port.
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `Timed out waiting for Narriflow web${lastStatus ? ` (last HTTP ${lastStatus})` : ""}: ${diagnostics().slice(-4_000)}`,
  );
}

async function stopProcess(child: ChildProcess | null) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    Bun.sleep(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function runCommand(
  label: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; secret: string },
) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-200_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 120_000);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  }).finally(() => clearTimeout(timeout));
  const safeOutput = redact(output, options.secret);
  assert.equal(code, 0, `${label} exited with ${code}: ${safeOutput.slice(-4_000)}`);
  progress(`${label}: passed`);
  return safeOutput;
}

function httpClient(url: URL, secret: string, mode: "auto" | "legacy") {
  const client = new Client(
    { name: `narriflow-e2e-${mode}`, version: "1.0.0" },
    { versionNegotiation: { mode } },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => secret },
  });
  return { client, transport };
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>) {
  return result.content
    ?.filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n") ?? "";
}

async function main() {
  assert.equal(
    process.env.MCP_E2E_ALLOW_DATABASE,
    "1",
    "Set MCP_E2E_ALLOW_DATABASE=1; this test creates and then revokes one scoped API key",
  );
  assert(process.env.DATABASE_URL, "DATABASE_URL is required");
  const prisma = getPrismaClient();
  assert(prisma, "Prisma is unavailable");

  const workspace = await prisma.workspace.findFirst({
    where: { status: "active", pricingTier: "business", members: { some: { role: "owner" } } },
    select: {
      id: true,
      members: { where: { role: "owner" }, select: { userId: true }, take: 1 },
    },
  });
  assert(workspace?.members[0], "An active Business workspace with an owner is required");
  const actorUserId = workspace.members[0].userId;
  const otherWorkspaceId = crypto.randomUUID();
  const generatedFileSnapshots = await snapshotFiles([
    join(webRoot, "AGENTS.md"),
    join(webRoot, "CLAUDE.md"),
    join(webRoot, "next-env.d.ts"),
  ]);

  const nonBusiness = await prisma.workspace.findFirst({
    where: {
      status: "active",
      pricingTier: { not: "business" },
      members: { some: { role: "owner" } },
    },
    select: {
      id: true,
      members: { where: { role: "owner" }, select: { userId: true }, take: 1 },
    },
  });
  if (nonBusiness?.members[0]) {
    await assert.rejects(
      workspaceService.createApiKey(nonBusiness.members[0].userId, nonBusiness.id, {
        name: `mcp-e2e-rejected-${Date.now()}`,
        scopes: ["projects:read"],
      }),
      /Business/,
    );
    const billingHandler = createMcpHandler(() => buildNarriflowMcpServer({
      kind: "oauth",
      userId: nonBusiness.members[0]!.userId,
      clientId: "narriflow-billing-e2e",
      scopes: ["openid"],
    }));
    const billingClient = new Client(
      { name: "narriflow-billing-e2e", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const billingTransport = new StreamableHTTPClientTransport(
      new URL("https://narriflow.billing.test/mcp"),
      { fetch: (input, init) => billingHandler.fetch(new Request(input, init)) },
    );
    await billingClient.connect(billingTransport);
    const denied = await billingClient.callTool({
      name: "narriflow_list_projects",
      arguments: { workspaceId: nonBusiness.id, limit: 1 },
    });
    assert.equal(denied.isError, true);
    assert.match(textContent(denied), /requires an active Business plan/);
    await billingClient.close();
    progress("non-Business API-key and MCP billing gates: passed");
  } else {
    progress("non-Business billing gate: skipped (no eligible fixture workspace)");
  }

  const key = await workspaceService.createApiKey(actorUserId, workspace.id, {
    name: `mcp-e2e-${Date.now()}`,
    scopes: ["projects:read", "usage:read", "autopilot:read", "brand:read"],
  });
  let keyRevoked = false;
  let web: ChildProcess | null = null;
  const clients: Client[] = [];
  const tempRoot = await mkdtemp(join(tmpdir(), "narriflow-mcp-e2e-"));

  try {
    const configuredOrigin = process.env.MCP_E2E_BASE_URL?.trim();
    let origin: string;

    if (configuredOrigin) {
      origin = new URL(configuredOrigin).origin;
      const health = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(health.status, 200, `Existing Narriflow server at ${origin} is not healthy`);
      progress("existing HTTP application server: ready");
    } else {
      const port = await freePort();
      origin = `http://127.0.0.1:${port}`;
      const serverEnv = {
        ...process.env,
        NODE_ENV: "development",
        NEXT_PUBLIC_APP_URL: origin,
        CLERK_OAUTH_ISSUER: clerkOAuthIssuer(),
      };
      web = spawn(
        process.env.MCP_E2E_NODE_BINARY ?? "node",
        [join(webRoot, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)],
        { cwd: webRoot, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
      );
      let webOutput = "";
      const collectWebOutput = (chunk: Buffer) => {
        webOutput = `${webOutput}${chunk.toString("utf8")}`.slice(-50_000);
      };
      web.stdout?.on("data", collectWebOutput);
      web.stderr?.on("data", collectWebOutput);
      await waitForServer(`${origin}/api/health`, web, () => redact(webOutput, key.secret));
      progress("HTTP application server: ready");
    }

    const mcpUrl = new URL("/mcp", origin);

    const resourceMetadata = await fetch(
      `${origin}/.well-known/oauth-protected-resource/mcp`,
      { signal: AbortSignal.timeout(10_000) },
    );
    assert.equal(resourceMetadata.status, 200);
    const resourceDocument = await resourceMetadata.json() as {
      resource?: string;
      authorization_servers?: string[];
      bearer_methods_supported?: string[];
    };
    assert.equal(resourceDocument.resource, mcpUrl.href);
    assert.deepEqual(resourceDocument.bearer_methods_supported, ["header"]);
    assert.equal(resourceDocument.authorization_servers?.length, 1);

    const authorizationMetadata = await fetch(
      `${origin}/.well-known/oauth-authorization-server`,
      { signal: AbortSignal.timeout(15_000) },
    );
    assert.equal(authorizationMetadata.status, 200);
    const authorizationDocument = await authorizationMetadata.json() as {
      authorization_endpoint?: string;
      token_endpoint?: string;
    };
    assert(authorizationDocument.authorization_endpoint);
    assert(authorizationDocument.token_endpoint);
    progress("OAuth protected-resource and authorization-server discovery: passed");

    const unauthorized = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("www-authenticate") ?? "", /^Bearer /);
    progress("HTTP bearer challenge: passed");

    const modern = httpClient(mcpUrl, key.secret, "auto");
    clients.push(modern.client);
    await modern.client.connect(modern.transport);
    const tools = await modern.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), expectedTools);

    const workspaces = await modern.client.callTool({ name: "narriflow_list_workspaces" });
    assert.equal(workspaces.isError, undefined);
    assert.match(textContent(workspaces), /"mcpEnabled": true/);

    const projects = await modern.client.callTool({
      name: "narriflow_list_projects",
      arguments: { workspaceId: workspace.id, limit: 2 },
    });
    assert.equal(projects.isError, undefined);
    assert.match(textContent(projects), /"items"/);

    const usage = await modern.client.callTool({
      name: "narriflow_get_workspace_usage",
      arguments: { workspaceId: workspace.id },
    });
    assert.equal(usage.isError, undefined);
    assert.match(textContent(usage), /"tier": "business"/);

    const rules = await modern.client.callTool({
      name: "narriflow_list_autopilot_rules",
      arguments: { workspaceId: workspace.id },
    });
    assert.equal(rules.isError, undefined);

    const brandProfiles = await modern.client.callTool({
      name: "narriflow_list_brand_profiles",
      arguments: { workspaceId: workspace.id },
    });
    assert.equal(brandProfiles.isError, undefined);

    const deniedReviewRead = await modern.client.callTool({
      name: "narriflow_list_review_rounds",
      arguments: { workspaceId: workspace.id, projectId: crypto.randomUUID() },
    });
    assert.equal(deniedReviewRead.isError, true);
    assert.match(textContent(deniedReviewRead), /requires the review:read scope/);

    const deniedPublishingMutation = await modern.client.callTool({
      name: "narriflow_recheck_social_publication",
      arguments: {
        workspaceId: workspace.id,
        socialPostId: crypto.randomUUID(),
        reason: "Verify least-privilege scope enforcement",
      },
    });
    assert.equal(deniedPublishingMutation.isError, true);
    assert.match(
      textContent(deniedPublishingMutation),
      /requires the publishing:write scope/,
    );

    const deniedWrite = await modern.client.callTool({
      name: "narriflow_run_autopilot_rule_now",
      arguments: { workspaceId: workspace.id, ruleId: crypto.randomUUID() },
    });
    assert.equal(deniedWrite.isError, true);
    assert.match(textContent(deniedWrite), /requires the autopilot:write scope/);

    const boundary = await modern.client.callTool({
      name: "narriflow_list_projects",
      arguments: { workspaceId: otherWorkspaceId, limit: 1 },
    });
    assert.equal(boundary.isError, true);
    assert.match(textContent(boundary), /bound to a different workspace/);
    progress("official SDK over modern HTTP with real billing/data authorization: passed");

    const legacy = httpClient(mcpUrl, key.secret, "legacy");
    clients.push(legacy.client);
    await legacy.client.connect(legacy.transport);
    assert.equal((await legacy.client.listTools()).tools.length, expectedTools.length);
    progress("official SDK legacy compatibility over HTTP: passed");

    const stdio = new Client(
      { name: "narriflow-e2e-stdio", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    clients.push(stdio);
    await stdio.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["run", stdioEntry],
      cwd: repoRoot,
      env: { ...process.env as Record<string, string>, NARRIFLOW_API_KEY: key.secret },
      stderr: "pipe",
    }));
    assert.deepEqual((await stdio.listTools()).tools.map((tool) => tool.name), expectedTools);
    assert.equal((await stdio.callTool({ name: "narriflow_list_workspaces" })).isError, undefined);
    progress("official SDK over stdio fallback: passed");

    const sharedConfig = join(tempRoot, "mcp.json");
    const claudeMcpConfig = {
      mcpServers: {
        narriflow: {
          type: "http",
          url: mcpUrl.href,
          headers: { Authorization: `Bearer ${key.secret}` },
        },
      },
    };
    await writeFile(sharedConfig, JSON.stringify(claudeMcpConfig));
    await chmod(sharedConfig, 0o600);

    const inspectorOutput = await runCommand(
      "MCP Inspector 2.2.0",
      "npm",
      [
        "exec", "--yes", "--package=@modelcontextprotocol/inspector@2.2.0", "--",
        "mcp-inspector", "--cli", "--config", sharedConfig, "--server", "narriflow",
        "--method", "tools/list", "--format", "json",
      ],
      {
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` },
        secret: key.secret,
      },
    );
    assert.match(inspectorOutput, /narriflow_list_workspaces/);

    const claudeProjectConfig = join(tempRoot, ".mcp.json");
    const claudeSettingsRoot = join(tempRoot, ".claude");
    await mkdir(claudeSettingsRoot);
    await writeFile(claudeProjectConfig, JSON.stringify(claudeMcpConfig));
    await chmod(claudeProjectConfig, 0o600);
    await writeFile(
      join(claudeSettingsRoot, "settings.local.json"),
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );
    const claudeTransportOutput = await runCommand(
      "Claude Code MCP transport",
      "claude",
      ["mcp", "list"],
      { cwd: tempRoot, timeoutMs: 60_000, secret: key.secret },
    );
    assert.match(claudeTransportOutput, /narriflow/);
    assert.match(claudeTransportOutput, /Connected/i);

    const runAllAiClients = process.env.MCP_E2E_AI_CLIENTS === "1";
    const runCodex = runAllAiClients || process.env.MCP_E2E_CODEX === "1";
    const runClaude = runAllAiClients || process.env.MCP_E2E_CLAUDE === "1";

    if (runCodex) {
      const codexOutput = await runCommand(
        "Codex client",
        "codex",
        [
          "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
          "-C", repoRoot, "-s", "read-only", "--json",
          "-c", `mcp_servers.narriflow.url=${JSON.stringify(mcpUrl.href)}`,
          "-c", "mcp_servers.narriflow.bearer_token_env_var=\"NARRIFLOW_MCP_E2E_KEY\"",
          "-c", "mcp_servers.narriflow.enabled_tools=[\"narriflow_list_workspaces\"]",
          "Use the Narriflow MCP server. Call narriflow_list_workspaces exactly once, then reply with MCP_CLIENT_OK.",
        ],
        {
          env: { ...process.env, NARRIFLOW_MCP_E2E_KEY: key.secret },
          timeoutMs: 180_000,
          secret: key.secret,
        },
      );
      assert.match(codexOutput, /narriflow_list_workspaces/);
      assert.match(codexOutput, /MCP_CLIENT_OK/);
    }

    if (runClaude) {
      const claudeOutput = await runCommand(
        "Claude Code client",
        "claude",
        [
          "-p", "Use the Narriflow MCP server. Call narriflow_list_workspaces exactly once, then reply with MCP_CLIENT_OK.",
          "--mcp-config", sharedConfig, "--strict-mcp-config", "--no-session-persistence",
          "--output-format", "stream-json", "--verbose", "--max-budget-usd", "0.25",
          "--tools", "mcp__narriflow__narriflow_list_workspaces",
          "--allowedTools", "mcp__narriflow__narriflow_list_workspaces",
        ],
        { cwd: tempRoot, timeoutMs: 180_000, secret: key.secret },
      );
      assert.match(claudeOutput, /mcp__narriflow__narriflow_list_workspaces/);
      assert.match(claudeOutput, /MCP_CLIENT_OK/);
    }

    if (!runCodex && !runClaude) {
      progress(
        "model-driven clients skipped (set MCP_E2E_CODEX=1, MCP_E2E_CLAUDE=1, or MCP_E2E_AI_CLIENTS=1)",
      );
    }

    await workspaceService.revokeApiKey(actorUserId, workspace.id, key.id);
    keyRevoked = true;

    const revokedStdio = await stdio.callTool({
      name: "narriflow_list_workspaces",
    });
    assert.equal(revokedStdio.isError, true);
    assert.match(textContent(revokedStdio), /API key is invalid or revoked/);
    progress("stdio API-key revocation without restart: passed");

    const revoked = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.secret}`,
        "content-type": "application/json",
        "mcp-method": "server/discover",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "revoked",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "revocation-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    assert.equal(revoked.status, 401);
    progress("API-key revocation: passed");
    await Promise.all(clients.splice(0).map((client) => client.close()));
    progress("all requested MCP end-to-end checks passed");
  } finally {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
    if (!keyRevoked) {
      await workspaceService.revokeApiKey(actorUserId, workspace.id, key.id).catch(() => undefined);
    }
    await stopProcess(web);
    await rm(tempRoot, { recursive: true, force: true });
    await restoreFiles(generatedFileSnapshots);
    await prisma.$disconnect();
  }
}

await main();
