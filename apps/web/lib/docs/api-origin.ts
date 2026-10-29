/**
 * The REST API and MCP server live on their own origin, set by
 * `NEXT_PUBLIC_API_URL` at build time. Docs pages write that origin as this
 * placeholder, and the MDX build (`source.config.ts`) replaces it everywhere a
 * page is rendered, so the HTML, Markdown and search text all show the real
 * address. A deployment that forgot the variable shows the placeholder host,
 * which resolves nowhere, instead of a plausible wrong one.
 */
export const DOCS_API_ORIGIN_PLACEHOLDER = "https://api.narriflow.example";

export function docsApiOrigin(env: Record<string, string | undefined> = process.env): string {
  return (env.NEXT_PUBLIC_API_URL?.trim() || "http://localhost:4000").replace(/\/+$/, "");
}

export function withDocsApiOrigin(text: string, origin = docsApiOrigin()): string {
  return text.split(DOCS_API_ORIGIN_PLACEHOLDER).join(origin);
}
