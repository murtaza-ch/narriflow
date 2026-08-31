import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  browserSessionLongLivedModules,
  browserSessionInheritedPageModules,
  browserSessionPageModules,
  browserSessionPages,
  browserSessionServerActions,
  browserSessionServerActionModules,
  browserSessionHonoSurfaces,
  independentTrustHonoSurfaces,
  isIndependentTrustHonoSurface,
  matchBrowserSessionHonoSurface,
} from "./authenticated-request-inventory";

const webRoot = new URL("../", import.meta.url);

async function globModules(pattern: string): Promise<string[]> {
  const modules: string[] = [];
  for await (const module of new Bun.Glob(pattern).scan({
    cwd: webRoot.pathname,
    onlyFiles: true,
  })) {
    modules.push(module);
  }
  return modules.sort();
}

function hasModifier(
  node: ts.Node,
  kind: ts.SyntaxKind.ExportKeyword | ts.SyntaxKind.AsyncKeyword,
): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
    : false;
}

function hasUseServerDirective(statements: ts.NodeArray<ts.Statement>): boolean {
  return statements.some(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) &&
      statement.expression.text === "use server",
  );
}

function runtimeActionNames(source: string, module: string): string[] {
  const file = ts.createSourceFile(
    module,
    source,
    ts.ScriptTarget.Latest,
    true,
    module.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const exportedNames = new Set<string>();
  const inlineActions: Array<{ name: string | null; position: number }> = [];
  const moduleLevel = hasUseServerDirective(file.statements);

  function isAsyncCallableExpression(
    expression: ts.Expression,
    seen = new Set<string>(),
  ): boolean {
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      return hasModifier(expression, ts.SyntaxKind.AsyncKeyword);
    }
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return false;
      seen.add(expression.text);
      for (const statement of file.statements) {
        if (
          ts.isFunctionDeclaration(statement) &&
          statement.name?.text === expression.text
        ) {
          return hasModifier(statement, ts.SyntaxKind.AsyncKeyword);
        }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (
              ts.isIdentifier(declaration.name) &&
              declaration.name.text === expression.text &&
              declaration.initializer
            ) {
              return isAsyncCallableExpression(declaration.initializer, seen);
            }
          }
        }
      }
    }
    return false;
  }

  for (const statement of file.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.body &&
      moduleLevel &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(statement, ts.SyntaxKind.AsyncKeyword)
    ) {
      exportedNames.add(statement.name.text);
    }
    if (
      moduleLevel &&
      ts.isVariableStatement(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          isAsyncCallableExpression(declaration.initializer)
        ) {
          exportedNames.add(declaration.name.text);
        }
      }
    }
  }

  function declarationName(node: ts.Node): string | null {
    if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
    if (ts.isMethodDeclaration(node) && node.name) return node.name.getText(file);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      if (ts.isPropertyAssignment(parent)) return parent.name.getText(file);
    }
    return null;
  }

  function visit(node: ts.Node) {
    const body =
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)) &&
      node.body &&
      ts.isBlock(node.body)
        ? node.body
        : null;
    if (body && hasUseServerDirective(body.statements)) {
      inlineActions.push({
        name: declarationName(node),
        position: node.getStart(file),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  const counts = new Map<string, number>();
  for (const action of inlineActions) {
    if (action.name) counts.set(action.name, (counts.get(action.name) ?? 0) + 1);
  }
  const inlineNames = inlineActions.map((action) => {
    if (action.name && counts.get(action.name) === 1) return action.name;
    const location = file.getLineAndCharacterOfPosition(action.position);
    return `${action.name ?? "<anonymous>"}@${location.line + 1}:${location.character + 1}`;
  });
  return [...exportedNames, ...inlineNames];
}

describe("authenticated request inventory", () => {
  test("discovers every supported inline Server Action function form", () => {
    const source = `
      async function declared() { "use server"; }
      const arrow = async () => { "use server"; };
      const expression = async function () { "use server"; };
      const object = {
        property: async () => { "use server"; },
        async method() { "use server"; },
      };
    `;
    expect(runtimeActionNames(source, "fixture.tsx").sort()).toEqual([
      "arrow",
      "declared",
      "expression",
      "method",
      "property",
    ]);
  });

  test("discovers only exported async callable bindings in action modules", () => {
    const source = `
      "use server";
      export const action = async () => {};
      export const helper = 1;
      const privateAction = async () => {};
      export function syncFunction() {}
    `;
    expect(runtimeActionNames(source, "fixture.ts")).toEqual(["action"]);
  });

  test("keeps anonymous and duplicate inline actions distinct by source position", () => {
    const source = `
      register(async () => { "use server"; });
      function first() {
        async function save() { "use server"; }
      }
      function second() {
        async function save() { "use server"; }
      }
    `;
    const names = runtimeActionNames(source, "fixture.tsx");
    expect(names.filter((name) => name.startsWith("<anonymous>@"))).toHaveLength(1);
    const saves = names.filter((name) => name.startsWith("save@"));
    expect(saves).toHaveLength(2);
    expect(new Set(saves).size).toBe(2);
  });

  test("declares exact capabilities and Project admission without HTTP-method inference", () => {
    expect(
      matchBrowserSessionHonoSurface("GET", "/projects/p1/clips/c1/download"),
    ).toMatchObject({
      operationName: "GET /projects/:id/clips/:clipId/download",
      params: { id: "p1", clipId: "c1" },
      admission: {
        kind: "project",
        capability: "content.download",
        projectId: "p1",
      },
    });
    expect(
      matchBrowserSessionHonoSurface("POST", "/projects/p1/clips/render"),
    ).toMatchObject({
      operationName: "POST /projects/:id/clips/render",
      admission: {
        kind: "project",
        capability: "processing.consume",
        projectId: "p1",
      },
    });
    expect(
      matchBrowserSessionHonoSurface("DELETE", "/social/accounts/a1"),
    ).toMatchObject({
      operationName: "DELETE /social/accounts/:accountId",
      admission: { kind: "workspace", capability: "social.manage" },
    });
  });

  test("declares strict policy input for Brand Profile mutation surfaces", () => {
    const create = matchBrowserSessionHonoSurface("POST", "/brand-profiles");
    expect(create?.input?.schema.safeParse({
      body: { name: "Northstar", slug: "northstar" },
    }).success).toBe(true);
    expect(create?.input?.schema.safeParse({
      body: { name: "Northstar", slug: "northstar", arbitrary: true },
    }).success).toBe(false);

    const update = matchBrowserSessionHonoSurface(
      "PATCH",
      "/brand-profiles/11111111-1111-4111-8111-111111111111",
    );
    expect(update?.params).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(update?.input?.schema.safeParse({
      id: "not-a-uuid",
      body: { revision: 1, name: "Northstar" },
    }).success).toBe(false);
  });

  test("authenticates, authorizes, bounds, and validates selected motion before routing", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const clipId = "22222222-2222-4222-8222-222222222222";
    const route = matchBrowserSessionHonoSurface(
      "POST",
      `/projects/${projectId}/campaign-operations/apply-motion`,
    );
    expect(route).toMatchObject({
      admission: {
        kind: "project",
        projectId,
        capability: "content.edit",
      },
      rateLimit: { limit: 20, windowSeconds: 3_600 },
      input: { body: "required", params: ["id"] },
    });
    expect(
      route?.rateLimit?.key({
        actorUserId: "actor-a",
        workspaceId: "workspace-a",
      }),
    ).toBe("apply-motion-selected:actor-a");
    expect(
      route?.input?.schema.safeParse({
        id: projectId,
        body: {
          change: {
            scope: "clip_transition",
            transition: { type: "slide-right", durationSec: 0.4 },
          },
          clips: [{ clipId, expectedEditorRevision: 8 }],
        },
      }).success,
    ).toBe(true);
    expect(
      route?.input?.schema.safeParse({
        id: projectId,
        body: {
          change: {
            scope: "clip_transition",
            transition: { type: "arbitrary-patch", durationSec: 0.4 },
          },
          clips: [{ clipId, expectedEditorRevision: 8 }],
        },
      }).success,
    ).toBe(false);
  });

  test("admits the public Studio generated-media submission shape", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const clipId = "22222222-2222-4222-8222-222222222222";
    const route = matchBrowserSessionHonoSurface(
      "POST",
      `/projects/${projectId}/generated-media/jobs`,
    );

    expect(route).toMatchObject({
      admission: {
        kind: "project",
        projectId,
        capability: "processing.consume",
      },
      rateLimit: { limit: 20, windowSeconds: 3_600 },
    });
    expect(
      route?.input?.schema.safeParse({
        id: projectId,
        body: {
          idempotencyKey: "33333333-3333-4333-8333-333333333333",
          projectId,
          clipId,
          kind: "image",
          prompt: "A quiet studio at first light",
          promptOrigin: { kind: "manual", sourceIds: [] },
          includeDerivedContext: false,
		  sourceRevision: null,
          aspectRatio: "9:16",
          style: "editorial",
          durationSec: null,
          title: null,
        },
      }).success,
    ).toBe(true);
  });

	test("requires download capability for generated result attachments", () => {
		const projectId = "11111111-1111-4111-8111-111111111111";
		const jobId = "22222222-2222-4222-8222-222222222222";
		const route = matchBrowserSessionHonoSurface(
			"GET",
			`/projects/${projectId}/generated-media/jobs/${jobId}/download`,
		);

		expect(route).toMatchObject({
			admission: {
				kind: "project",
				projectId,
				capability: "content.download",
			},
			params: { id: projectId, jobId },
			input: { params: ["id", "jobId"] },
		});
	});

  test("keeps brand and style Campaign Operations project-scoped and strictly revision fenced", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const clipId = "22222222-2222-4222-8222-222222222222";
    const templateId = "33333333-3333-4333-8333-333333333333";
    const fingerprint = "a".repeat(64);
    const catalog = matchBrowserSessionHonoSurface(
      "GET",
      `/projects/${projectId}/campaign-operations/editor-action-catalog`,
    );
    expect(catalog).toMatchObject({
      admission: {
        kind: "project",
        projectId,
        capability: "content.view",
      },
      input: { params: ["id"] },
    });
    const preview = matchBrowserSessionHonoSurface(
      "POST",
      `/projects/${projectId}/campaign-operations/preview-editor-action`,
    );
    expect(preview).toMatchObject({
      admission: {
        kind: "project",
        projectId,
        capability: "content.view",
      },
      rateLimit: { limit: 60, windowSeconds: 60 },
    });
    expect(
      preview?.input?.schema.safeParse({
        id: projectId,
        body: {
          action: "apply_style",
          input: {
            templateId,
            templateFingerprint: fingerprint,
            clips: [{ clipId, expectedEditorRevision: 5 }],
          },
        },
      }).success,
    ).toBe(true);

    const brand = matchBrowserSessionHonoSurface(
      "POST",
      `/projects/${projectId}/campaign-operations/apply-brand-profile`,
    );
    expect(brand).toMatchObject({
      admission: {
        kind: "project",
        projectId,
        capability: "content.edit",
      },
      rateLimit: { limit: 20, windowSeconds: 3_600 },
    });
    expect(
      brand?.input?.schema.safeParse({
        id: projectId,
        body: {
          profileFingerprint: fingerprint,
          styleFingerprint: null,
          clips: [{ clipId, expectedEditorRevision: 5 }],
        },
      }).success,
    ).toBe(true);
    expect(
      brand?.input?.schema.safeParse({
        id: projectId,
        body: {
          profileId: templateId,
          profileFingerprint: fingerprint,
          styleFingerprint: null,
          clips: [{ clipId, expectedEditorRevision: 5 }],
        },
      }).success,
    ).toBe(false);

    const style = matchBrowserSessionHonoSurface(
      "POST",
      `/projects/${projectId}/campaign-operations/apply-style`,
    );
    expect(style).toMatchObject({
      admission: {
        kind: "project",
        projectId,
        capability: "content.edit",
      },
      rateLimit: { limit: 20, windowSeconds: 3_600 },
    });
    expect(
      style?.input?.schema.safeParse({
        id: projectId,
        body: {
          templateId,
          templateFingerprint: fingerprint,
          clips: [{ clipId, expectedEditorRevision: 5 }],
        },
      }).success,
    ).toBe(true);
  });

  test("keeps durable publishing-preparation reads available with content-view access", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const draftId = "22222222-2222-4222-8222-222222222222";
    const jobId = "33333333-3333-4333-8333-333333333333";
    const history = matchBrowserSessionHonoSurface(
      "GET",
      `/projects/${projectId}/assisted-copy`,
    );

    expect(history).toMatchObject({
      admission: {
        kind: "project",
        projectId,
        capability: "content.view",
      },
      input: { params: ["id"], query: ["platform"] },
    });
    expect(
      history?.input?.schema.safeParse({
        id: projectId,
        platform: "youtube_shorts",
      }).success,
    ).toBe(true);
    expect(
      history?.input?.schema.safeParse({ id: projectId, platform: "youtube" })
        .success,
    ).toBe(false);

    expect(
      matchBrowserSessionHonoSurface(
        "GET",
        `/projects/${projectId}/assisted-copy/${draftId}`,
      ),
    ).toMatchObject({
      admission: {
        kind: "project",
        projectId,
        capability: "content.view",
      },
    });
    expect(
      matchBrowserSessionHonoSurface(
        "GET",
        `/projects/${projectId}/thumbnail-extractions/${jobId}`,
      ),
    ).toMatchObject({
      admission: {
        kind: "project",
        projectId,
        capability: "content.view",
      },
    });
    const thumbnailHistory = matchBrowserSessionHonoSurface(
      "GET",
      `/projects/${projectId}/thumbnail-extractions`,
    );
    expect(thumbnailHistory).toMatchObject({
      admission: {
        kind: "project",
        projectId,
        capability: "content.view",
      },
      input: {
        params: ["id"],
        query: ["platform", "exportVariantIds"],
      },
    });
    expect(
      thumbnailHistory?.input?.schema.safeParse({
        id: projectId,
        platform: "tiktok",
        exportVariantIds: jobId,
      }).success,
    ).toBe(true);
  });

  test("keeps independent trust models out of browser-session policy", () => {
    expect(isIndependentTrustHonoSurface("POST", "/webhooks/stripe")).toBe(
      true,
    );
    expect(isIndependentTrustHonoSurface("GET", "/social/oauth/callback")).toBe(
      true,
    );
    expect(isIndependentTrustHonoSurface("GET", "/projects")).toBe(false);
  });

  test("preserves every established abuse scope and bound", () => {
    const cases = [
      ["POST", "/autopilot/rules", "autopilot-create:workspace-a", 5, 3_600],
      [
        "POST",
        "/autopilot/rules/r1/run-now",
        "autopilot-run:workspace-a",
        10,
        3_600,
      ],
      ["POST", "/projects/p1/generate", "gen:actor-a", 20, 60],
      ["POST", "/ingest/rss/preview", "rss-preview:workspace-a", 20, 60],
      ["POST", "/ingest/rss/import", "rss-import:workspace-a", 5, 60],
      ["POST", "/projects/p1/content-suite", "content-suite:actor-a", 30, 60],
      ["POST", "/projects/p1/social-posts", "social-posts:actor-a", 30, 60],
      ["POST", "/projects/p1/dubs", "dubs:actor-a", 20, 60],
      [
        "POST",
        "/upload-sessions/discard",
        "upload-session-discard:actor-a",
        30,
        60,
      ],
    ] as const;
    for (const [method, path, key, limit, windowSeconds] of cases) {
      const declaration = matchBrowserSessionHonoSurface(method, path);
      expect(declaration?.rateLimit).toBeDefined();
      expect(
        declaration?.rateLimit?.key({
          actorUserId: "actor-a",
          workspaceId: "workspace-a",
        }),
      ).toBe(key);
      expect(declaration?.rateLimit).toMatchObject({ limit, windowSeconds });
    }
  });

  test("has no duplicate method and path entries", () => {
    const keys = [
      ...browserSessionHonoSurfaces,
      ...independentTrustHonoSurfaces,
    ].map((surface) => `${surface.method} ${surface.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("declares every route registered by the browser Hono app", async () => {
    const source = (
      await Promise.all([
        "app/api/[[...route]]/route.ts",
        "app/api/[[...route]]/brand-profile-routes.ts",
        "app/api/[[...route]]/generated-media-http.ts",
      ].map((module) => Bun.file(new URL(module, webRoot)).text()))
    ).join("\n");
    const registered = source.matchAll(
      /app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g,
    );
    for (const [, method, path] of registered) {
      expect(
        matchBrowserSessionHonoSurface(method ?? "", path ?? "") ??
          (isIndependentTrustHonoSurface(method ?? "", path ?? "")
            ? { independent: true }
            : null),
      ).not.toBeNull();
    }
  });

  test("registers every main-app inventory declaration", async () => {
    const source = await Bun.file(
      new URL("app/api/[[...route]]/route.ts", webRoot),
    ).text();
    const registered = new Set(
      [...source.matchAll(/app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g)].map(
        ([, method, path]) => `${method?.toUpperCase()} ${path}`,
      ),
    );
    const extractedPrefixes = [
      "/upload-sessions/",
      "/billing/",
      "/brand-profiles",
      "/visual-assets",
      "/brand-fonts",
      "/projects/:id/generated-media/",
			"/projects/:id/clips/:clipId/generated-media/",
    ];
    const expected = [
      ...browserSessionHonoSurfaces.filter(
        ({ path }) => !extractedPrefixes.some((prefix) => path.startsWith(prefix)),
      ),
      ...independentTrustHonoSurfaces.filter(
        ({ path }) => path !== "/webhooks/stripe",
      ),
    ].map(({ method, path }) => `${method} ${path}`);

    expect(expected.filter((route) => !registered.has(route))).toEqual([]);
  });

  test("inventories every action, page admission, and long-lived stream through the approved adapters", async () => {
    for (const module of browserSessionServerActionModules) {
      const source = await Bun.file(new URL(module, webRoot)).text();
      expect(source).toContain("authenticated-request-action");
    }
    for (const module of browserSessionPageModules) {
      const source = await Bun.file(new URL(module, webRoot)).text();
      expect(source).toContain("authenticated-request-page");
    }
    for (const module of browserSessionInheritedPageModules) {
      const source = await Bun.file(new URL(module, webRoot)).text();
      expect(source.length).toBeGreaterThan(0);
    }
    for (const module of browserSessionLongLivedModules) {
      const source = await Bun.file(new URL(module, webRoot)).text();
      expect(source).toContain("freshAuthenticatedRequestPolicy");
    }
  });

  test("discovers every Server Action module and declares each action's exact admission", async () => {
    const candidates = await globModules("app/**/*.{ts,tsx}");
    const discoveredModules: string[] = [];
    const discoveredActions: string[] = [];

    for (const module of candidates) {
      const source = await Bun.file(new URL(module, webRoot)).text();
      const parsed = ts.createSourceFile(
        module,
        source,
        ts.ScriptTarget.Latest,
        true,
        module.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const hasDirective = hasUseServerDirective(parsed.statements) ||
        [...source.matchAll(/["']use server["'];/g)].length > 0;
      const hasAdapter = source.includes("authenticated-request-action");
      if (!hasDirective && !hasAdapter) continue;
      discoveredModules.push(module);
      for (const name of runtimeActionNames(source, module)) {
        discoveredActions.push(`${module}#${name}`);
      }
    }

    expect(discoveredModules.sort()).toEqual(
      [...browserSessionServerActionModules].sort(),
    );
    expect([...new Set(discoveredActions)].sort()).toEqual(
      browserSessionServerActions
        .map(({ module, exportName }) => `${module}#${exportName}`)
        .sort(),
    );

    for (const declaration of browserSessionServerActions) {
      const source = await Bun.file(new URL(declaration.module, webRoot)).text();
      const start = source.search(
        new RegExp(`(?:function|const)\\s+${declaration.exportName}\\b`),
      );
      expect(start).toBeGreaterThanOrEqual(0);
      const laterStarts = browserSessionServerActions
        .filter(({ module, exportName }) =>
          module === declaration.module && exportName !== declaration.exportName,
        )
        .map(({ exportName }) =>
          source.search(new RegExp(`(?:function|const)\\s+${exportName}\\b`)),
        )
        .filter((position) => position > start);
      const end = laterStarts.length > 0 ? Math.min(...laterStarts) : source.length;
      const body = source.slice(start, end);
      const executePattern =
        declaration.admission === "signed_in"
          ? /executeSignedInAction(?:WithInput)?\(/
          : declaration.admission === "project"
          ? new RegExp(
              `executeProjectAction(?:WithInput)?\\([\\s\\S]*?,\\s*["']${declaration.capability}["']`,
            )
          : new RegExp(
              `executeWorkspaceAction(?:WithInput)?\\(\\s*["']${declaration.capability}["']`,
            );
      if (!executePattern.test(body)) {
        const alias = body.match(/=\s*(\w+Action)\s*;/)?.[1];
        const target = browserSessionServerActions.find(
          ({ module, exportName }) =>
            module === declaration.module && exportName === alias,
        );
        expect(target).toMatchObject({
          admission: declaration.admission,
          ...(declaration.admission === "signed_in"
            ? {}
            : { capability: declaration.capability }),
        });
      }
    }
  });

  test("discovers every page and layout below the authenticated app boundary", async () => {
    const discovered = (await globModules("app/(app)/**/{page,layout}.tsx")).sort();
    const declared = [
      ...browserSessionPageModules.filter((module) => module.startsWith("app/(app)/")),
      ...browserSessionInheritedPageModules,
    ].sort();
    expect(discovered).toEqual(declared);
  });

  test("declares and verifies each direct page admission and capability", async () => {
    for (const declaration of browserSessionPages) {
      const source = await Bun.file(new URL(declaration.module, webRoot)).text();
      const helper =
        declaration.admission === "signed_in"
          ? "admitSignedInPage"
          : declaration.admission === "project"
          ? "admitProjectPage"
          : declaration.admission === "optional_workspace"
            ? "admitOptionalWorkspacePage"
            : "admitWorkspacePage";
      expect(source).toContain(helper);
      if (declaration.admission === "signed_in") {
        expect(new RegExp(`${helper}\\(`).test(source)).toBe(true);
      } else if (declaration.capability === "content.view") {
        expect(
          declaration.admission === "project"
            ? new RegExp(`${helper}\\([^,;)]+,\\s*["']content.view["']\\)`).test(source)
            : new RegExp(`${helper}\\(\\s*["']content.view["']\\s*\\)`).test(source),
        ).toBe(true);
      } else {
        expect(source).toContain(`"${declaration.capability}"`);
      }
    }
  });

  test("migrated surfaces cannot restore direct actor policy or handwritten common failures", async () => {
    const modules = [
      "app/api/[[...route]]/route.ts",
      ...browserSessionServerActionModules,
      ...browserSessionPageModules,
      ...browserSessionLongLivedModules,
    ];
    const forbidden = [
      "getCurrentAppUser",
      "requireCurrentAppUser",
      "getCurrentWorkspaceAppUser",
      "requireWorkspaceAppUser",
      "requireActiveProject",
      '"Unauthorized"',
      '"Forbidden"',
      '"Project not found"',
      '"Invalid payload"',
      ".message ===",
    ];
    for (const module of modules) {
      const source = await Bun.file(new URL(module, webRoot)).text();
      for (const value of forbidden) expect(source).not.toContain(value);
    }
  });
});
