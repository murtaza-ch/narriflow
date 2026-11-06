import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { Prisma, PrismaClient } from "@prisma/client";
import { clipExportService, findCoveringInFlightExport } from "./clip-export.service";
import { workspaceService } from "./workspace.service";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const CLIP = "00000000-0000-4000-8000-000000000003";
const scope = { actorUserId: "00000000-0000-4000-8000-000000000004", workspaceId: WORKSPACE };

function exportRow(id: string, status: string, overrides: Record<string, unknown> = {}) {
  const finished = status === "ready";
  return {
    id, projectId: PROJECT, clipId: CLIP, editorRevision: 2, resolution: "1080p", watermark: false, status, progress: 0, errorCode: null,
    createdAt: new Date("2026-11-06T10:00:00.000Z"), completedAt: null,
    clip: { title: "A clip", hookText: "A hook", editorRevision: 2 }, project: { title: "A project" },
    variants: [{ id: `${id}-variant`, aspectRatio: "ratio_9_16", resolution: "1080p", watermark: false,
      status: finished ? "completed" : status === "failed" ? "failed" : status === "rendering" ? "rendering" : "pending",
      storageKey: finished ? "projects/a.mp4" : null, sizeBytes: null, durationSec: null, errorCode: null, completedAt: null }],
    ...overrides,
  };
}

let rows: unknown[] = [];
const findMany = mock(async (_query: Prisma.ClipExportFindManyArgs) => rows);
const fakePrisma = {
  clipExport: { findMany },
  project: { findUnique: async () => ({ expiresAt: null, purgeStartedAt: null }) },
} as unknown as PrismaClient;

const globals = createDatabaseTestContext();
const previousPrisma = globals.client;
const previousEnv = { ...process.env };
beforeAll(bindServiceTestEnvironment(globals.bind(() => {
  globals.client = fakePrisma;
  Object.assign(process.env, { DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused.test/db", R2_ACCOUNT_ID: "account", R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket" });
  spyOn(workspaceService, "requireActor").mockResolvedValue(undefined as never);
})));
afterAll(bindServiceTestEnvironment(globals.bind(() => {
  globals.client = previousPrisma;
  process.env = previousEnv;
  mock.restore();
})));

describe("project render states", () => {
  test("returns queued, rendering and failed exports the finished-only list leaves out", bindServiceTestEnvironment(globals.bind(async () => {
    rows = [exportRow("queued", "queued"), exportRow("rendering", "rendering"), exportRow("failed", "failed", { errorCode: "render_failed" }), exportRow("ready", "ready")];
    const states = await clipExportService.listProjectRenderStates(scope, PROJECT);
    expect(states.map((item) => [item.id, item.status])).toEqual([["queued", "queued"], ["rendering", "rendering"], ["failed", "failed"], ["ready", "ready"]]);
    expect(states[2]?.errorCode).toBe("render_failed");
    expect(states[0]?.variants[0]?.hasAsset).toBe(false);
    expect(states[0]?.variants[0]?.previewUrl).toBeNull();
    expect(states[3]?.variants[0]?.hasAsset).toBe(true);
    expect(states[3]?.variants[0]?.previewUrl).toEqual(expect.any(String));
    const query = findMany.mock.calls.at(-1)?.[0];
    expect(query?.where).not.toHaveProperty("status");
    expect(query?.where).toMatchObject({ workspaceId: WORKSPACE, projectId: PROJECT });
    expect(query?.orderBy).toEqual({ createdAt: "desc" });
  })));

  test("drops exports cut from an older revision", bindServiceTestEnvironment(globals.bind(async () => {
    rows = [exportRow("older", "failed", { editorRevision: 1 }), exportRow("current", "rendering")];
    expect((await clipExportService.listProjectRenderStates(scope, PROJECT)).map((item) => item.id)).toEqual(["current"]);
  })));

  test("the finished-only list keeps its contract", bindServiceTestEnvironment(globals.bind(async () => {
    rows = [exportRow("ready", "ready")];
    expect((await clipExportService.listCurrentProjectExports(scope, PROJECT)).map((item) => item.id)).toEqual(["ready"]);
    expect(findMany.mock.calls.at(-1)?.[0]?.where).toMatchObject({ status: { in: ["partial_ready", "ready"] } });
  })));
});

describe("in-flight export guard", () => {
  const request = { clipId: CLIP, editorRevision: 2, resolution: "1080p", watermark: false, aspectRatios: ["9:16"] } as const;
  function txWith(live: Array<{ id: string; variants: Array<{ aspectRatio: string }> }>) {
    const query = mock(async (_args: Prisma.ClipExportFindManyArgs) => live);
    return { tx: { clipExport: { findMany: query } } as never, query };
  }
  const row = (id: string, ...ratios: string[]) => ({ id, variants: ratios.map((aspectRatio) => ({ aspectRatio })) });

  test("reuses a live export of the same format", bindServiceTestEnvironment(async () => {
    const { tx } = txWith([row("live", "ratio_9_16")]);
    expect(await findCoveringInFlightExport(tx, { ...request, aspectRatios: [...request.aspectRatios] })).toEqual({ id: "live" });
  }));

  test("reuses a live export that renders more than was asked for", bindServiceTestEnvironment(async () => {
    const { tx } = txWith([row("studio", "ratio_1_1", "ratio_9_16")]);
    expect(await findCoveringInFlightExport(tx, { ...request, aspectRatios: ["9:16"] })).toEqual({ id: "studio" });
  }));

  test("lets a request add a format no live export renders", bindServiceTestEnvironment(async () => {
    const { tx } = txWith([row("live", "ratio_9_16")]);
    expect(await findCoveringInFlightExport(tx, { ...request, aspectRatios: ["9:16", "1:1"] })).toBeNull();
    expect(await findCoveringInFlightExport(tx, { ...request, aspectRatios: ["1:1"] })).toBeNull();
  }));

  test("looks only at live exports of this clip, revision and output, so failed ones stay retryable", bindServiceTestEnvironment(async () => {
    const { tx, query } = txWith([]);
    expect(await findCoveringInFlightExport(tx, { ...request, aspectRatios: ["9:16"] })).toBeNull();
    expect(query.mock.calls[0]?.[0]?.where).toEqual({
      clipId: CLIP, editorRevision: 2, resolution: "1080p", watermark: false, status: { in: ["queued", "rendering"] },
    });
  }));
});
