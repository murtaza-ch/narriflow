import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ADMISSION_TABLES } from "./domains";
import type { AdmissionEntry } from "./domains/platform/admission-table";
import { createRouteApp, RouteRegistrationError } from "./http/admission";
import type { ApiEnv } from "./http/env";
import { checkRouteInventory, declaredRoutes } from "./route-inventory";
import { createInventoryApp } from "./test-app";

const WORKSPACE_READ = { kind: "workspace", capability: "content.view" } as const;

const WORKSPACE_EDIT = { kind: "workspace", capability: "content.edit" } as const;

function appWith(register: (app: Hono<ApiEnv>) => void): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  register(app);
  return app;
}

const ok = (c: { text(value: string): Response }) => c.text("x");

describe("route inventory comparison", () => {
  test("the composed API registers exactly the declared routes, each behind its guard", () => {
    const report = checkRouteInventory(createInventoryApp());
    expect(report.problems).toEqual([]);
    // Every mounted route is declared; the count grows as domains add routes.
    expect(report.checkedRoutes).toBeGreaterThan(108);
  });

  test("every declaration has a distinct key across domains", () => {
    const keys = Object.entries(ADMISSION_TABLES)
      .filter(([domain]) => domain !== "rest")
      .flatMap(([, table]) => Object.keys(table));
    expect(new Set(keys).size).toBe(keys.length);
    expect(declaredRoutes().size).toBe(keys.length);
  });

  test("flags a registered route that nothing declares", () => {
    const app = appWith((a) =>
      a.route("/", createRouteApp({ "GET /api/rogue": WORKSPACE_READ }).get("/api/rogue", ok)),
    );
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
    const app = appWith((a) => a.get("/api/open", ok));
    expect(checkRouteInventory(app, declared).problems).toEqual([
      {
        kind: "missing_admission",
        route: "GET /api/open",
        detail: "first handler is not registered with its declaration",
      },
    ]);
  });

  test("flags a route registered with trust where an admission is declared", () => {
    const declared = new Map<string, AdmissionEntry>([["GET /api/x", WORKSPACE_READ]]);
    const app = appWith((a) =>
      a.route("/", createRouteApp({ "GET /api/x": { trust: "public_share_token" } }).get("/api/x", ok)),
    );
    expect(checkRouteInventory(app, declared).problems).toEqual([
      { kind: "missing_admission", route: "GET /api/x", detail: "first handler is trust, declared admission" },
    ]);
  });

  test("flags a parameter route that is registered before a literal path it would swallow", () => {
    const table = { "GET /api/items/:id": WORKSPACE_READ, "GET /api/items/explorer": WORKSPACE_READ } as const;
    const declared = new Map<string, AdmissionEntry>(Object.entries(table));
    const swallowed = appWith((a) =>
      a.route(
        "/",
        createRouteApp(table).get("/api/items/:id", ok).get("/api/items/explorer", ok),
      ),
    );
    expect(checkRouteInventory(swallowed, declared).problems).toEqual([
      {
        kind: "shadowed_route",
        route: "GET /api/items/explorer",
        detail: "answered by GET /api/items/:id",
      },
    ]);
    const ordered = appWith((a) =>
      a.route(
        "/",
        createRouteApp(table).get("/api/items/explorer", ok).get("/api/items/:id", ok),
      ),
    );
    expect(checkRouteInventory(ordered, declared).problems).toEqual([]);
  });

  test("flags the same route registered by two domains", () => {
    const table = { "GET /api/twice": WORKSPACE_READ } as const;
    const declared = new Map<string, AdmissionEntry>(Object.entries(table));
    const app = appWith((a) =>
      a
        .route("/", createRouteApp(table).get("/api/twice", ok))
        .route("/", createRouteApp(table).get("/api/twice", ok)),
    );
    expect(checkRouteInventory(app, declared).problems).toEqual([
      { kind: "duplicate_registration", route: "GET /api/twice", detail: "2 registrations" },
    ]);
  });

  // The F01 shape: an unguarded registration in front of (or behind) a guarded
  // one for the same route used to leave a single admission marker and pass.
  test("flags an unguarded duplicate in front of a guarded registration", () => {
    const table = { "GET /api/probe": WORKSPACE_READ } as const;
    const declared = new Map<string, AdmissionEntry>(Object.entries(table));
    const app = appWith((a) => {
      a.get("/api/probe", ok);
      a.route("/", createRouteApp(table).get("/api/probe", ok));
    });
    expect(checkRouteInventory(app, declared).problems).toEqual([
      {
        kind: "missing_admission",
        route: "GET /api/probe",
        detail: "first handler is not registered with its declaration",
      },
      { kind: "duplicate_registration", route: "GET /api/probe", detail: "2 registrations" },
    ]);
  });

  test("flags an unguarded duplicate behind a guarded registration", () => {
    const table = { "GET /api/probe": WORKSPACE_READ } as const;
    const declared = new Map<string, AdmissionEntry>(Object.entries(table));
    const app = appWith((a) => {
      a.route("/", createRouteApp(table).get("/api/probe", ok));
      a.get("/api/probe", ok);
    });
    expect(checkRouteInventory(app, declared).problems).toEqual([
      { kind: "duplicate_registration", route: "GET /api/probe", detail: "2 registrations" },
    ]);
  });
});

describe("createRouteApp", () => {
  const table = { "GET /a": WORKSPACE_READ, "POST /a": WORKSPACE_EDIT } as const;

  test("refuses a route that the table does not declare", () => {
    expect(() => createRouteApp(table).get("/b", ok)).toThrow(RouteRegistrationError);
    // The method is part of the declaration.
    expect(() => createRouteApp(table).put("/a", ok)).toThrow(RouteRegistrationError);
  });

  test("refuses a second registration of the same route and a route without a handler", () => {
    expect(() => createRouteApp(table).get("/a", ok).get("/a", ok)).toThrow("registered twice");
    expect(() => (createRouteApp(table) as unknown as { get(path: string): unknown }).get("/a")).toThrow(
      "no handler",
    );
  });

  test("refuses every other way of adding routes", () => {
    const app = createRouteApp(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ["use", "all", "on", "route", "mount"]) {
      expect(() => app[name]?.("/a", ok)).toThrow(RouteRegistrationError);
    }
  });

  test("installs exactly one entry per handler, led by the declaration", () => {
    const app = createRouteApp(table).get("/a", ok, ok).post("/a", ok);
    expect(app.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /a",
      "GET /a",
      "GET /a",
      "POST /a",
      "POST /a",
    ]);
  });
});
