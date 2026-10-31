/** Test-only guard. Shared development resources are never a test target. */
export function assertExecutionDatabaseTestTarget(raw: string | undefined, schema: string): asserts raw is string {
  if (!raw) throw new Error("An isolated execution database is required");
  const target = new URL(raw);
  const disposable = /^serverless_execution_test_[a-z0-9]+$/.test(schema);
  if (schema !== "public" && !disposable) throw new Error("A disposable execution schema is required");
  const isolatedNeon = target.hostname === "ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech";
  const isolatedLocal = ["localhost", "127.0.0.1"].includes(target.hostname) &&
    /^\/narriflow_serverless_gates_[a-z0-9_]+$/.test(target.pathname) && disposable;
  if (!isolatedNeon && !isolatedLocal) throw new Error("Execution gates require an isolated test database");
}
