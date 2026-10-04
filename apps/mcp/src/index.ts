import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildNarriflowMcpServer } from "@narriflow/mcp-core";
import { createNarriflowTokenVerifier, principalFromMcpAuth } from "@narriflow/mcp-core/auth";
import { createAuthenticatedStdioTransport } from "@narriflow/mcp-core/stdio";
import { checkRateLimit, workspaceService } from "@narriflow/services";

const secret = process.env.NARRIFLOW_API_KEY?.trim();
if (!secret) throw new Error("NARRIFLOW_API_KEY is required for the Narriflow stdio MCP server");
const verifier = createNarriflowTokenVerifier({
  resourceUrl: () => "http://localhost/mcp", secretKey: () => undefined, findUser: async () => null,
  authenticateApiKey: (token) => workspaceService.authenticateApiKey(token),
});
const authenticate = async () => principalFromMcpAuth(await verifier.verifyAccessToken(secret));
const initialPrincipal = await authenticate();
const admission = createAuthenticatedStdioTransport({ wire: new StdioServerTransport(), authenticate, checkRateLimit });
serveStdio(({ era }) => buildNarriflowMcpServer(initialPrincipal, {
  protocolEra: era,
  authenticatePrincipal: admission.authenticatePrincipal, assertNewMutationAllowed: admission.assertNewMutationAllowed,
}), { transport: admission.transport });
