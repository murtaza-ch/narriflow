import { expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "./client";
import { createDatabaseTestContext } from "./testing";

test("fixture clients are injected into their bound test without a process global", async () => {
  const context = createDatabaseTestContext();
  const fixture = {} as PrismaClient;
  const fault = {} as PrismaClient;
  context.client = fixture;
  await context.bind(async () => {
    expect(getPrismaClient()).toBe(fixture);
    context.client = fault;
    await Promise.resolve();
    expect(getPrismaClient()).toBe(fault);
  })();
  expect(getPrismaClient()).toBeNull();
});
