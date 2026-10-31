import { expect, test } from "bun:test";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";

test("execution gates refuse the shared branch and local application databases before connecting", () => {
  const schema = "serverless_execution_test_abc123";
  for (const url of ["postgresql://localhost/narriflow", "postgresql://ep-rough-hill-b57kvyah.c-7.us-east-2.aws.neon.tech/neondb", "postgresql://example.com/neondb"]) {
    expect(() => assertExecutionDatabaseTestTarget(url, schema)).toThrow("isolated test database");
  }
  expect(() => assertExecutionDatabaseTestTarget("postgresql://localhost/narriflow_serverless_gates_test", "public")).toThrow();
  expect(() => assertExecutionDatabaseTestTarget("postgresql://localhost/narriflow_serverless_gates_test", schema)).not.toThrow();
});
