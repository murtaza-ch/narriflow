import { getClerkOAuthIssuer } from "@/lib/mcp-auth";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function GET() {
  const metadataUrl = new URL("/.well-known/oauth-authorization-server", getClerkOAuthIssuer());
  try {
    const response = await fetch(metadataUrl, {
      headers: { Accept: "application/json" },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return Response.json({ error: "authorization_server_metadata_unavailable" }, { status: 502 });
    }
    return Response.json(await response.json(), { headers: corsHeaders });
  } catch {
    return Response.json({ error: "authorization_server_metadata_unavailable" }, { status: 502 });
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
