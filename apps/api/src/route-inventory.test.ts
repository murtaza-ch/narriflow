import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ADMISSION_TABLES } from "./domains";
import type { AdmissionEntry } from "./domains/platform/admission-table";
import { admit } from "./http/admission";
import type { ApiEnv } from "./http/env";
import { checkRouteInventory, declaredRoutes } from "./route-inventory";
import { createInventoryApp } from "./test-app";

const WORKSPACE_READ = { kind: "workspace", capability: "content.view" } as const;

function appWith(register: (app: Hono<ApiEnv>) => void): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  register(app);
  return app;
}

describe("route inventory comparison", () => {
  test("the composed API registers exactly the declared routes, each behind its guard", () => {
    const report = checkRouteInventory(createInventoryApp());
    expect(report.problems).toEqual([]);
    // 105 partitioned handlers + health + ready + the Clerk webhook.
    expect(report.checkedRoutes).toBe(108);
  });

  test("every declaration has a distinct key across domains", () => {
    const keys = Object.entries(ADMISSION_TABLES)
      .filter(([domain]) => domain !== "rest")
      .flatMap(([, table]) => Object.keys(table));
    expect(new Set(keys).size).toBe(keys.length);
    expect(declaredRoutes().size).toBe(keys.length);
  });

  test("flags a registered route that nothing declares", () => {
    const app = appWith((a) => a.get("/api/rogue", admit(WORKSPACE_READ), (c) => c.text("x")));
    expect(checkRouteInventory(app, new Map()).problems).toEqual([
      { kind: "undeclared_route", route: "GET /api/rogue" },
    ]);
  });

  test("flags a declaration that no route registers", () => {
    const declared = new Map<string, AdmissionEntry>([["GET /api/ghost", WORKSPACE_READ]]);
    expect(checkRouteInventory(new Hono<ApiEnv>(), declared).problems).toEqual([
      { kind: "phantom_declaration", route: "GET /api/ghost" },
    ]);
  });

  test("flags a declared route registered without its guard", () => {
    const declared = new Map<string, AdmissionEntry>([["GET /api/open", WORKSPACE_READ]]);
    const app = appWith((a) => a.get("/api/open", (c) => c.text("x")));
    expect(checkRouteInventory(app, declared).problems).toEqual([
      { kind: "missing_admission", route: "GET /api/open" },
    ]);
  });

  test("flags a parameter route that is registered before a literal path it would swallow", () => {
    const declared = new Map<string, AdmissionEntry>([
      ["GET /api/items/:id", WORKSPACE_READ],
      ["GET /api/items/explorer", WORKSPACE_READ],
    ]);
    const swallowed = appWith((a) =>
      a
        .get("/api/items/:id", admit(WORKSPACE_READ), (c) => c.text("id"))
        .get("/api/items/explorer", admit(WORKSPACE_READ), (c) => c.text("lit")),
    );
    expect(checkRouteInventory(swallowed, declared).problems).toEqual([
      {
        kind: "shadowed_route",
        route: "GET /api/items/explorer",
        detail: "answered by GET /api/items/:id",
      },
    ]);
    const ordered = appWith((a) =>
      a
        .get("/api/items/explorer", admit(WORKSPACE_READ), (c) => c.text("lit"))
        .get("/api/items/:id", admit(WORKSPACE_READ), (c) => c.text("id")),
    );
    expect(checkRouteInventory(ordered, declared).problems).toEqual([]);
  });

  test("flags the same route registered by two domains", () => {
    const declared = new Map<string, AdmissionEntry>([["GET /api/twice", WORKSPACE_READ]]);
    const app = appWith((a) =>
      a
        .get("/api/twice", admit(WORKSPACE_READ), (c) => c.text("a"))
        .get("/api/twice", admit(WORKSPACE_READ), (c) => c.text("b")),
    );
    expect(checkRouteInventory(app, declared).problems).toEqual([
      { kind: "duplicate_registration", route: "GET /api/twice", detail: "2 admissions" },
    ]);
  });
});
