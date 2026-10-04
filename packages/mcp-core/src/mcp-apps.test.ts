import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { registerNarriflowMcpApps } from "./mcp-apps";

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });
async function connect(apps: boolean, mode: "auto" | "legacy" = "auto") {
  const handler = createMcpHandler(({ era }) => {
    const server = new McpServer({ name: "apps-test", version: "1" });
    registerNarriflowMcpApps(server, { appOrigin: "https://narriflow.test", protocolEra: era, connectDomains: ["https://bucket.storage.test"], callUpload: async () => ({ content: [], structuredContent: { action: "grants", outcome: "granted" }, _meta: { uploadTransfer: { grants: [{ url: "https://bucket.storage.test/private-grant" }] } } }), acceptPublication: async () => ({ content: [], structuredContent: { status: "confirmed" }, _meta: { confirmationReceipt: "private-receipt" } }) });
    return server;
  });
  const client = new Client({ name: "apps-client", version: "1" }, { capabilities: apps ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } : {}, versionNegotiation: { mode } });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL("https://narriflow.test/mcp"), { fetch: (input, init) => handler.fetch(new Request(input, init)) }));
  return client;
}

describe("MCP Apps delivery", () => {
  test("serves card HTML to an Apps host using the SDK's stateless legacy transport", async () => {
    const client = await connect(true, "legacy");
    for (const view of ["upload", "progress", "clip-review", "publication-confirmation"]) {
      const result = await client.readResource({ uri: `ui://narriflow/v1/${view}.html` });
      expect(result.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      expect(result.contents[0] && "text" in result.contents[0] ? result.contents[0].text : "").toContain(`data-view="${view}"`);
    }
  });
  test("serves an immutable bridge template with explicit upload CSP and no private results", async () => {
    const client = await connect(true);
    const result = await client.readResource({ uri: "ui://narriflow/v1/upload.html" });
    const content = result.contents[0];
    expect(content?.mimeType).toBe("text/html;profile=mcp-app");
    expect(content && "text" in content ? content.text : "").toContain("Upload and generate clips");
    expect(content && "text" in content ? content.text : "").not.toContain("private-grant");
    expect(content?._meta).toEqual({ ui: { csp: { connectDomains: ["https://narriflow.test", "https://bucket.storage.test"], resourceDomains: ["https://narriflow.test"], frameDomains: [] } } });
  });

  test("CSP permits the bucket origin used by signed upload and preview URLs", async () => {
    const previousAccount = process.env.R2_ACCOUNT_ID;
    const previousBucket = process.env.R2_BUCKET;
    process.env.R2_ACCOUNT_ID = "a".repeat(32);
    process.env.R2_BUCKET = "narriflow-test";
    try {
      const client = await connect(true);
      const result = await client.readResource({ uri: "ui://narriflow/v1/upload.html" });
      const csp = (result.contents[0]?._meta?.ui as { csp: { connectDomains: string[]; resourceDomains: string[] } }).csp;
      const bucketOrigin = `https://narriflow-test.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
      expect(csp.connectDomains).toContain(bucketOrigin);
      expect(csp.resourceDomains).toContain(bucketOrigin);
      expect(csp.connectDomains).not.toContain("https://*.r2.cloudflarestorage.com");
    } finally {
      if (previousAccount === undefined) delete process.env.R2_ACCOUNT_ID; else process.env.R2_ACCOUNT_ID = previousAccount;
      if (previousBucket === undefined) delete process.env.R2_BUCKET; else process.env.R2_BUCKET = previousBucket;
    }
  });

  test("static card templates remain readable for host prefetch and inspection", async () => {
    const client = await connect(false);
    const result = await client.readResource({ uri: "ui://narriflow/v1/upload.html" });
    expect(result.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    expect(JSON.stringify(result)).not.toContain("private-grant");
  });

  test("legacy host bridge can call transfer and confirmation tools after initialization", async () => {
    const client = await connect(true, "legacy");
    const transfer = await client.callTool({ name: "narriflow_upload_grants", arguments: { workspaceId: "b6558e07-d826-46a2-a919-4c9a4e7c4c62", sessionId: "27ea4880-e97e-49a4-b8e0-8af86e00a1d7", partNumbers: [1] } });
    expect(transfer.isError).not.toBe(true);
    expect(transfer._meta?.uploadTransfer).toBeDefined();
    const confirmation = await client.callTool({ name: "narriflow_accept_social_post_intent", arguments: { workspaceId: "b6558e07-d826-46a2-a919-4c9a4e7c4c62", token: "signed-intent", accepted: true } });
    expect(confirmation.isError).not.toBe(true);
    expect(confirmation._meta?.confirmationReceipt).toBe("private-receipt");
  });

  test("modern bridge calls still require declared Apps capability", async () => {
    const client = await connect(false);
    const result = await client.callTool({ name: "narriflow_upload_grants", arguments: { workspaceId: "b6558e07-d826-46a2-a919-4c9a4e7c4c62", sessionId: "27ea4880-e97e-49a4-b8e0-8af86e00a1d7", partNumbers: [1] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("MCP Apps capability is required");
    expect(result._meta?.uploadTransfer).toBeUndefined();
  });

  test("picker transfer tools are App-only and keep upload grants outside structured results", async () => {
    const client = await connect(true);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "narriflow_accept_social_post_intent",
      "narriflow_upload_discard", "narriflow_upload_finalize", "narriflow_upload_grants",
      "narriflow_upload_open", "narriflow_upload_status",
    ]);
    expect(tools.tools.find((tool) => tool.name === "narriflow_upload_grants")?._meta?.ui).toEqual({ resourceUri: "ui://narriflow/v1/upload.html", visibility: ["app"] });
    const result = await client.callTool({ name: "narriflow_upload_grants", arguments: { workspaceId: "b6558e07-d826-46a2-a919-4c9a4e7c4c62", sessionId: "27ea4880-e97e-49a4-b8e0-8af86e00a1d7", partNumbers: [1] } });
    expect(JSON.stringify(result.structuredContent)).not.toContain("private-grant");
    expect(JSON.stringify(result.content)).not.toContain("private-grant");
    expect(JSON.stringify(result._meta)).toContain("private-grant");
  });
});
