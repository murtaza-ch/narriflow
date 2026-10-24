import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildNarriflowMcpServer } from "@narriflow/mcp-core";
import { appendWorkspaceEvent, workspaceService } from "@narriflow/services";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { createRestApi } from "./app";

const url = process.env.INTEGRATION_TEST_DATABASE_URL;
const schema = process.env.INTEGRATION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_INTEGRATION_DB_TESTS === "1" && Boolean(url);
const db = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);

const SECRET = `nf_${"e".repeat(40)}`;
const projectId = randomUUID();

db("REST and MCP Workspace Event feeds", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let userId: string;
  let workspaceId: string;
  let scopes: string[] = [];
  const globals = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  let previousGlobalPrisma: PrismaClient | undefined;

  beforeAll(async () => {
    if (!url || !schema || !/^integration_test_[a-z0-9_]+$/.test(schema)) throw new Error("Event feed tests require a disposable schema");
    pool = new Pool({ connectionString: url, max: 8 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    previousGlobalPrisma = globals.narriflowPrismaClient;
    globals.narriflowPrismaClient = prisma;
    userId = (await prisma.user.create({ data: { clerkId: `event-feed:${randomUUID()}` } })).id;
    workspaceId = (await prisma.workspace.create({ data: { name: "Feed", ownerUserId: userId, pricingTier: "business", members: { create: { userId, role: "owner" } } } })).id;
    spyOn(workspaceService, "authenticateApiKey").mockImplementation((async (secret: string) =>
      secret === SECRET ? { apiKeyId: randomUUID(), userId, workspaceId, name: "Feed", scopes } : null) as never);
    await prisma.$transaction(async (tx) => {
      const operation = (tag: string) => appendWorkspaceEvent(tx, { workspaceId, projectId: null, type: "operation.finished", dedupeKey: `feed:${tag}`,
        subject: { operation: { kind: "generation", id: tag }, projectId, state: "completed" } });
      await operation("one");
      await appendWorkspaceEvent(tx, { workspaceId, projectId: null, type: "autopilot.episode_imported", dedupeKey: "feed:episode",
        subject: { ruleId: randomUUID(), projectId, episodeId: "guid-1" } });
      await appendWorkspaceEvent(tx, { workspaceId, projectId: null, type: "social_post.finished", dedupeKey: "feed:post",
        subject: { socialPostId: randomUUID(), projectId, clipId: null, platform: "youtube_shorts", state: "posted" } });
      await operation("two");
    });
  });
  afterAll(async () => {
    globals.narriflowPrismaClient = previousGlobalPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  const rest = createRestApi({ checkRateLimit: async () => ({ allowed: true, availability: "available", remaining: 299, limit: 300 }), appOrigin: () => "https://narriflow.test", log: () => {} });
  const restEvents = async (granted: string[], query = "") => {
    scopes = granted;
    const response = await rest.request(`/api/v1/events${query}`, { headers: { authorization: `Bearer ${SECRET}` } });
    return { status: response.status, body: await response.json() as { data: Array<{ seq: number; type: string }>; nextCursor: string } };
  };
  const mcpCall = async (granted: string[], args: Record<string, unknown> = {}) => {
    const handler = createMcpHandler(() => buildNarriflowMcpServer({ kind: "api_key", userId, clientId: "feed-client", apiKeyId: randomUUID(), workspaceId, scopes: granted }));
    const response = await handler.fetch(new Request("https://narriflow.test/mcp", { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call", "mcp-name": "narriflow_list_events" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "narriflow_list_events", arguments: args, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "feed-test", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {} } } }) }));
    const text = await response.text();
    const raw = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
    return JSON.parse(raw).result as { isError?: boolean; structuredContent: { data?: unknown } };
  };
  const mcpEvents = async (granted: string[], args: Record<string, unknown> = {}) =>
    (await mcpCall(granted, args)).structuredContent.data as { data: Array<{ seq: number; type: string }>; nextCursor: string };

  test("REST and MCP return the same rows and cursor for the same credential", async () => {
    const granted = ["projects:read", "publishing:read"];
    const { status, body } = await restEvents(granted);
    expect(status).toBe(200);
    expect(body.data.map((event) => event.type)).toEqual(["operation.finished", "autopilot.episode_imported", "social_post.finished", "operation.finished"]);
    expect(body.nextCursor).toBe("4");
    expect(await mcpEvents(granted)).toEqual(body);

    const restPage = await restEvents(granted, "?limit=2&after=1");
    expect(restPage.body.data.map((event) => event.seq)).toEqual([2, 3]);
    expect(await mcpEvents(granted, { limit: 2, after: "1" })).toEqual(restPage.body);

    const restTyped = await restEvents(granted, "?types=autopilot.episode_imported,operation.finished");
    expect(restTyped.body.data.map((event) => event.type)).toEqual(["operation.finished", "autopilot.episode_imported", "operation.finished"]);
    expect(await mcpEvents(granted, { types: ["autopilot.episode_imported", "operation.finished"] })).toEqual(restTyped.body);

    const empty = await restEvents(granted, "?after=4");
    expect(empty.body).toEqual({ data: [], nextCursor: "4" });
    expect(await mcpEvents(granted, { after: "4" })).toEqual(empty.body);
  });

  test("posting outcomes need publishing:read on both surfaces", async () => {
    const granted = ["projects:read"];
    const { body } = await restEvents(granted);
    expect(body.data.map((event) => event.type)).toEqual(["operation.finished", "autopilot.episode_imported", "operation.finished"]);
    expect(body.nextCursor).toBe("4");
    expect(await mcpEvents(granted)).toEqual(body);
  });

  test("naming only types the credential can't see is refused with the scope it lacks, on both surfaces", async () => {
    const granted = ["projects:read"];
    for (const types of ["social_post.finished", "social_post.proposed", "social_post.finished,social_post.proposed"]) {
      const refused = await restEvents(granted, `?types=${types}`);
      expect(`${types} ${refused.status}`).toBe(`${types} 403`);
      expect(refused.body).toMatchObject({ error: "scope_required", details: { scope: "publishing:read" } });
      const refusedByMcp = await mcpCall(granted, { types: types.split(",") });
      expect(refusedByMcp.isError).toBe(true);
      expect(refusedByMcp.structuredContent.data).toMatchObject({ error: "scope_required", details: { scope: "publishing:read" } });
    }
    // Mixed with visible types, the hidden ones are filtered out silently; so is an unfiltered read.
    const mixed = await restEvents(granted, "?types=social_post.finished,operation.finished");
    expect(mixed.status).toBe(200);
    expect(mixed.body.data.map((event) => event.type)).toEqual(["operation.finished", "operation.finished"]);
    expect(await mcpEvents(granted, { types: ["social_post.finished", "operation.finished"] })).toEqual(mixed.body);
    // With the scope, the same request returns them.
    expect((await restEvents(["projects:read", "publishing:read"], "?types=social_post.finished")).body.data.map((event) => event.seq)).toEqual([3]);
  });

  test("order=desc returns the newest matching events newest first, the same rows on both surfaces", async () => {
    const granted = ["projects:read", "publishing:read"];
    const all = await restEvents(granted, "?order=desc");
    expect(all.status).toBe(200);
    expect(all.body.data.map((event) => event.seq)).toEqual([4, 3, 2, 1]);
    expect(await mcpEvents(granted, { order: "desc" })).toEqual(all.body);

    const newest = await restEvents(granted, "?order=desc&limit=2");
    expect(newest.body.data.map((event) => event.seq)).toEqual([4, 3]);
    expect(await mcpEvents(granted, { order: "desc", limit: 2 })).toEqual(newest.body);

    const typed = await restEvents(granted, "?order=desc&types=operation.finished,autopilot.episode_imported&limit=2");
    expect(typed.body.data.map((event) => event.seq)).toEqual([4, 2]);
    expect(await mcpEvents(granted, { order: "desc", limit: 2, types: ["operation.finished", "autopilot.episode_imported"] })).toEqual(typed.body);

    // What the credential can't see is filtered from a descending read like an ascending one.
    const limited = await restEvents(["projects:read"], "?order=desc");
    expect(limited.body.data.map((event) => event.seq)).toEqual([4, 2, 1]);
    expect(await mcpEvents(["projects:read"], { order: "desc" })).toEqual(limited.body);

    // The default is still ascending, and `order=asc` is the same read.
    expect((await restEvents(granted, "?order=asc")).body).toEqual((await restEvents(granted)).body);
  });

  test("a descending page's cursor is its highest seq, a forward cursor that never points backwards", async () => {
    const granted = ["projects:read", "publishing:read"];
    const newest = await restEvents(granted, "?order=desc&limit=2");
    expect(newest.body.nextCursor).toBe("4");
    // Reading ascending from it finds nothing newer and keeps the cursor where it was.
    expect((await restEvents(granted, `?after=${newest.body.nextCursor}`)).body).toEqual({ data: [], nextCursor: "4" });
    // A page that stops short of the head still carries its own highest seq.
    const filtered = await restEvents(granted, "?order=desc&types=autopilot.episode_imported");
    expect(filtered.body).toMatchObject({ data: [{ seq: 2 }], nextCursor: "2" });
    expect((await restEvents(granted, `?after=${filtered.body.nextCursor}`)).body.data.map((event) => event.seq)).toEqual([3, 4]);
    // An empty page's cursor is the Workspace's head.
    const none = await restEvents(granted, "?order=desc&types=social_post.proposed");
    expect(none.body).toEqual({ data: [], nextCursor: "4" });
    expect(await mcpEvents(granted, { order: "desc", types: ["social_post.proposed"] })).toEqual(none.body);
  });

  test("order=desc has no cursor to continue from: combining it with after is a 400 invalid_request", async () => {
    const granted = ["projects:read", "publishing:read"];
    const refused = await restEvents(granted, "?order=desc&after=2");
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "invalid_request" });
    const refusedByMcp = await mcpCall(granted, { order: "desc", after: "2" });
    expect(refusedByMcp.isError).toBe(true);
    expect(refusedByMcp.structuredContent.data).toMatchObject({ error: "invalid_request" });
    expect((await restEvents(granted, "?order=sideways")).status).toBe(400);
  });

  test("REST requires projects:read and rejects unknown types and malformed cursors", async () => {
    expect((await restEvents(["publishing:read"])).status).toBe(403);
    expect((await restEvents(["projects:read"], "?types=made.up")).status).toBe(400);
    expect((await restEvents(["projects:read"], "?after=abc")).status).toBe(400);
    expect((await restEvents(["projects:read"], "?limit=201")).status).toBe(400);
    expect((await restEvents(["projects:read"], "?limit=0")).status).toBe(400);
  });
});
