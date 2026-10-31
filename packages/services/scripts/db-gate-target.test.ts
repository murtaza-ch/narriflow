import { expect, test } from "bun:test";
import { assertIsolatedDatabaseGateTarget } from "./db-gate-target";

test("database gates accept isolated local and candidate targets", () => {
  for (const url of ["postgresql://postgres:postgres@localhost/narriflow_serverless_gates_ci", "postgres://postgres@127.0.0.1/narriflow_serverless_gates_20261031", "postgresql://private@ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech/serverless_pipeline_gates"]) {
    expect(() => assertIsolatedDatabaseGateTarget(url)).not.toThrow();
  }
});

test("database gates reject shared hosts and databases without exposing credentials", () => {
  for (const url of ["postgresql://user:private-password@ep-rough-hill-b57kvyah.c-7.us-east-2.aws.neon.tech/neondb", "postgresql://user:private-password@localhost/neondb", "postgresql://user:private-password@ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech/neondb"]) {
    try { assertIsolatedDatabaseGateTarget(url); throw Error("Guard admitted a shared database"); }
    catch (error) { expect(String(error)).toContain("shared development is forbidden"); expect(String(error)).not.toContain("private-password"); }
  }
});
