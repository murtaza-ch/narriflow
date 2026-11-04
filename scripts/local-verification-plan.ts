export const DATABASE_CHECKS = ["execution", "workflow", "upload-session", "processing-usage", "workspace-billing", "social-publication", "clip-editor-persistence", "authenticated-request-policy", "brand-profiles", "vizard-expansion", "integration-api", "library-search", "schema-drift"] as const;

export function assertLocalTestDatabase(database: string) {
const target = new URL(database);
if (!["postgres:", "postgresql:"].includes(target.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !/^\/narriflow_serverless_gates_[a-z0-9_]+$/.test(target.pathname)) {
  throw new Error("Local verification requires an isolated local narriflow_serverless_gates_* database. Shared and cloud databases are refused.");
}
}
