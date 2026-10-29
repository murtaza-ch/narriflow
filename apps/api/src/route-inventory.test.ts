import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ADMISSION_TABLES } from "./domains";
import type { AdmissionEntry } from "./domains/platform/admission-table";
import { createRouteApp, requireAdmissionDeclaration, RouteRegistrationError } from "./http/admission";
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

// F01 (round 3): an `ALL` entry used to be skipped wholesale. Behind the
// fail-closed guard (or in an app without one) it must belong to a declared
// registration, whatever way it was added.
describe("route inventory and ALL entries", () => {
  const table = { "GET /api/probe": WORKSPACE_READ } as const;
  const declared = new Map<string, AdmissionEntry>(Object.entries(table));
  const guarded = (register: (firstParty: Hono<ApiEnv>) => void): Hono<ApiEnv> => {
    const firstParty = new Hono<ApiEnv>();
    firstParty.use("*", (_c, next) => next()); // composition middleware, before the guard
    firstParty.use("*", requireAdmissionDeclaration());
    register(firstParty);
    return new Hono<ApiEnv>().route("/", firstParty);
  };
  const problem = (route: string) => ({
    kind: "unregistered_handler",
    route,
    detail: "answers every method without belonging to a declared registration",
  });

  test("the plain-Hono shape Sol reproduced: all() on a clone ahead of the declared GET", () => {
    const domain = createRouteApp(table);
    const clone = Hono.prototype.basePath.call(new Hono<ApiEnv>(), "/") as Hono<ApiEnv>;
    clone.all("/api/probe", (c) => c.json({ unauthorized: true }));
    const app = new Hono<ApiEnv>().route("/", clone).route("/", domain.get("/api/probe", ok));
    expect(checkRouteInventory(app, declared).problems).toEqual([problem("ALL /api/probe")]);
  });

  test.each([
    ["all", (a: Hono<ApiEnv>) => a.all("/api/probe", ok), "ALL /api/probe"],
    ["use on the endpoint", (a: Hono<ApiEnv>) => a.use("/api/probe", ok), "ALL /api/probe"],
    ["use with a wildcard", (a: Hono<ApiEnv>) => a.use("/api/*", ok), "ALL /api/*"],
    ["on with every method", (a: Hono<ApiEnv>) => a.on(["GET", "POST"], "/api/probe", ok), null],
    [
      "route() of a child that holds an ALL entry",
      (a: Hono<ApiEnv>) => a.route("/", new Hono<ApiEnv>().all("/api/probe", ok)),
      "ALL /api/probe",
    ],
    ["mount", (a: Hono<ApiEnv>) => a.mount("/api/probe", () => new Response("x")), "ALL /api/probe/*"],
  ] as const)("flags an unregistered ALL handler added by %s (no guard in the app)", (_name, add, route) => {
    const app = new Hono<ApiEnv>();
    add(app);
    app.route("/", createRouteApp(table).get("/api/probe", ok));
    const found = checkRouteInventory(app, declared).problems;
    if (route) expect(found).toContainEqual(problem(route));
    else expect(found.length).toBeGreaterThan(0);
  });

  test.each([
    ["all", (a: Hono<ApiEnv>) => a.all("/api/probe", ok), "ALL /api/probe"],
    ["use with a wildcard", (a: Hono<ApiEnv>) => a.use("/api/*", ok), "ALL /api/*"],
    [
      "route() of a child that holds an ALL entry",
      (a: Hono<ApiEnv>) => a.route("/", new Hono<ApiEnv>().all("/api/probe", ok)),
      "ALL /api/probe",
    ],
  ] as const)("flags an unregistered ALL handler added by %s behind the guard", (_name, add, route) => {
    const app = guarded((firstParty) => {
      add(firstParty);
      firstParty.route("/", createRouteApp(table).get("/api/probe", ok));
    });
    expect(checkRouteInventory(app, declared).problems).toContainEqual(problem(route));
  });

  test("ALL entries in front of the guard are composition middleware and pass", () => {
    const app = guarded((firstParty) => {
      firstParty.route("/", createRouteApp(table).get("/api/probe", ok));
    });
    expect(checkRouteInventory(app, declared).problems).toEqual([]);
  });

  test("a marked trust-area guard behind the admission guard passes; protocol prefixes are left alone", () => {
    const app = guarded((firstParty) => {
      firstParty.route("/", createRouteApp(table).get("/api/probe", ok));
      firstParty.use("/api/v1/*", ok);
    });
    expect(checkRouteInventory(app, declared).problems).toEqual([]);
  });

  test("the real composition, with a domain whose hatch attempt was refused, reports nothing", () => {
    expect(checkRouteInventory(createInventoryApp()).problems).toEqual([]);
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
    for (const name of ["use", "all", "on", "route", "mount", "options", "basePath"]) {
      expect(() => app[name]?.("/a", ok)).toThrow(RouteRegistrationError);
    }
  });

  test("the sealed methods cannot be reassigned or redefined", () => {
    const app = createRouteApp(table) as unknown as Record<string, unknown>;
    expect(() => {
      app.all = () => app;
    }).toThrow();
    expect(() => Object.defineProperty(app, "use", { value: () => app })).toThrow();
    expect(() => {
      app.routes = [];
    }).toThrow();
    expect(() => {
      app.router = {};
    }).toThrow();
  });

  // F01 (round 3): `basePath` returns Hono's plain clone, which shares the router
  // and route list. Every registration ends in `router.add` / `routes`, so the
  // clone, the prototype methods and the internals are all closed.
  describe("adversarial registration hatches on the returned app", () => {
    const prototypeMethods = ["route", "mount"] as const;

    test("basePath itself refuses, so no clone exists", () => {
      expect(() => createRouteApp(table).basePath("/")).toThrow(RouteRegistrationError);
    });

    test("a clone taken from the shared prototype still cannot register", () => {
      const app = createRouteApp(table);
      const clone = Hono.prototype.basePath.call(app, "/") as Hono<ApiEnv>;
      expect(() => clone.all("/a", ok)).toThrow(RouteRegistrationError);
      expect(() => clone.use("/a", ok)).toThrow(RouteRegistrationError);
      expect(() => clone.on("GET", "/a", ok)).toThrow(RouteRegistrationError);
      expect(() => clone.get("/a", ok)).toThrow(RouteRegistrationError);
      expect(() => clone.route("/x", new Hono<ApiEnv>().get("/y", ok))).toThrow(RouteRegistrationError);
      expect(() => clone.mount("/m", () => new Response("x"))).toThrow(RouteRegistrationError);
      expect(app.routes).toHaveLength(0);
    });

    for (const name of prototypeMethods) {
      test(`Hono.prototype.${name} called on the domain app refuses`, () => {
        const app = createRouteApp(table);
        const method = (Hono.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
        const args =
          name === "route"
            ? ["/x", new Hono<ApiEnv>().get("/y", ok)]
            : name === "mount"
              ? ["/m", () => new Response("x")]
              : name === "on"
                ? ["GET", "/a", ok]
                : ["/a", ok];
        expect(() => method?.apply(app, args)).toThrow(RouteRegistrationError);
        expect(app.routes).toHaveLength(0);
      });
    }

    test("the router and the route list refuse direct writes", () => {
      const app = createRouteApp(table);
      expect(() => app.router.add("GET", "/a", [ok, {}] as never)).toThrow(RouteRegistrationError);
      expect(() => app.routes.push({ method: "ALL", path: "/a", handler: ok, basePath: "/" } as never)).toThrow(
        RouteRegistrationError,
      );
      expect(() => app.routes.splice(0, 1)).toThrow(RouteRegistrationError);
      expect(() => {
        app.routes.length = 0;
      }).toThrow(RouteRegistrationError);
    });

    test("declared registrations still work after refused attempts, and keep their order", () => {
      const app = createRouteApp(table);
      expect(() => app.all("/a", ok)).toThrow();
      app.get("/a", ok).post("/a", ok);
      expect(app.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
        "GET /a",
        "GET /a",
        "POST /a",
        "POST /a",
      ]);
    });

    test("a refused hatch leaves nothing for the runtime guard to refuse", async () => {
      const domain = createRouteApp({ "GET /probe": WORKSPACE_READ });
      expect(() => domain.basePath("/").all("/probe", ok)).toThrow(RouteRegistrationError);
      domain.get("/probe", ok);
      const mounted = new Hono<ApiEnv>().route("/api", domain);
      expect(checkRouteInventory(mounted, new Map([["GET /api/probe", WORKSPACE_READ]])).problems).toEqual([]);
    });
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
