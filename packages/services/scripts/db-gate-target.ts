/** Refuse the shared development database before creating even a test schema. */
export function assertIsolatedDatabaseGateTarget(raw: string): void {
  let target: URL;
  try { target = new URL(raw); } catch { throw Error("A PostgreSQL test database URL is required"); }
  const local = ["localhost", "127.0.0.1"].includes(target.hostname) && /^\/narriflow_serverless_gates_[a-z0-9_]+$/.test(target.pathname);
  const candidate = target.hostname === "ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech" && target.pathname === "/serverless_pipeline_gates";
  if (!["postgres:", "postgresql:"].includes(target.protocol) || (!local && !candidate)) {
    throw Error("Database gates require an isolated test target. Use local narriflow_serverless_gates_* or the isolated serverless pipeline database; shared development is forbidden.");
  }
}
