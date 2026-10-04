import { WORKSPACE_API_KEY_SCOPES } from "@narriflow/validators";

export async function inspectMcpConfiguration(options: {
  resourceUrl?: string;
  issuerUrl?: string;
  hasVerificationSecret: boolean;
  hasConfirmationSecret: boolean;
  fetch?: typeof fetch;
}) {
  if (!options.resourceUrl || !options.issuerUrl || !options.hasVerificationSecret) return { label: "Setup incomplete", description: "Configure the canonical app URL, Clerk OAuth issuer and verification secret before connecting.", verified: false };
  try {
    const resource = new URL(options.resourceUrl);
    const issuer = new URL(options.issuerUrl);
    if (!["https:", "http:"].includes(resource.protocol) || issuer.protocol !== "https:") throw new Error("Invalid MCP configuration");
    const response = await (options.fetch ?? fetch)(new URL("/.well-known/oauth-authorization-server", issuer), { signal: AbortSignal.timeout(3_000), cache: "no-store" });
    if (!response.ok) throw new Error("OAuth discovery is unavailable");
    const metadata: unknown = await response.json();
    if (!metadata || typeof metadata !== "object") throw new Error("Invalid OAuth discovery");
    const data = metadata as Record<string, unknown>;
    if (data.issuer !== issuer.href.replace(/\/$/, "") || !Array.isArray(data.code_challenge_methods_supported) || !data.code_challenge_methods_supported.includes("S256") || typeof data.authorization_endpoint !== "string" || typeof data.token_endpoint !== "string") throw new Error("OAuth discovery does not match the configured issuer");
    const scopes = Array.isArray(data.scopes_supported) ? data.scopes_supported : [];
    const missing = WORKSPACE_API_KEY_SCOPES.filter((scope) => !scopes.includes(scope));
    if (missing.length) return { label: "OAuth scopes missing", description: "Clerk discovery does not advertise all Narriflow application scopes. Ask an administrator to configure read and write consent.", verified: false };
    if (!options.hasConfirmationSecret) return { label: "Confirmation setup needed", description: "OAuth discovery and scopes are verified. Configure the shared continuation secret to enable exact-post confirmation.", verified: false };
    return { label: "Discovery verified", description: "The configured issuer advertises PKCE and Narriflow application scopes. Complete an OAuth connection in each client to verify resource binding and the full workflow.", verified: true };
  } catch {
    return { label: "Verification unavailable", description: "OAuth discovery could not be verified. Check the issuer configuration and try again.", verified: false };
  }
}
