import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { registerNarriflowMcpApps } from "./mcp-apps";

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });
async function connect(apps: boolean) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "apps-test", version: "1" });
    registerNarriflowMcpApps(server, { appOrigin: "https://narriflow.test", connectDomains: ["https://bucket.storage.test"], callUpload: async () => ({ content: [], structuredContent: { action: "grants", outcome: "granted" }, _meta: { uploadTransfer: { grants: [{ url: "https://bucket.storage.test/private-grant" }] } } }) });
    return server;
  });
  const client = new Client({ name: "apps-client", version: "1" }, { capabilities: apps ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } : {}, versionNegotiation: { mode: "auto" } });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL("https://narriflow.test/mcp"), { fetch: (input, init) => handler.fetch(new Request(input, init)) }));
  return client;
}

describe("MCP Apps delivery", () => {
  test("serves an immutable bridge template with explicit upload CSP and no private results", async () => {
    const client = await connect(true);
    const result = await client.readResource({ uri: "ui://narriflow/v1/upload.html" });
    const content = result.contents[0];
    expect(content?.mimeType).toBe("text/html;profile=mcp-app");
    expect(content && "text" in content ? content.text : "").toContain("Upload and generate clips");
    expect(content && "text" in content ? content.text : "").not.toContain("private-grant");
    expect(content?._meta).toEqual({ ui: { csp: { connectDomains: ["https://narriflow.test", "https://bucket.storage.test"], resourceDomains: ["https://narriflow.test"], frameDomains: [] } } });
  });

  test("declines UI resource requests from a client without the Apps extension", async () => {
    const client = await connect(false);
    await expect(client.readResource({ uri: "ui://narriflow/v1/upload.html" })).rejects.toThrow("MCP Apps capability is required");
  });

  test("picker transfer tools are App-only and keep upload grants outside structured results", async () => {
    const client = await connect(true);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
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
