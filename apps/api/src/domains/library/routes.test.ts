import { describe, expect, mock, test } from "bun:test";
import { ExpectedDomainFailureError } from "@narriflow/services";
import { mountDomain, PROJECT_ID, policyRuntime, signedInHeaders, workspaceContext } from "../projects/test-support";
import { createLibraryRoutes, type LibraryRouteDeps } from "./routes";

const FOLDER_ID = "22222222-2222-4222-8222-222222222222";
const json = { ...signedInHeaders, "content-type": "application/json" };

function libraryApp(deps: Record<string, unknown>, runtimeOptions: Parameters<typeof policyRuntime>[0] = {}) {
  return mountDomain(createLibraryRoutes(deps as unknown as LibraryRouteDeps), policyRuntime(runtimeOptions));
}

/** A fake of the receipt-backed command that behaves like the real one: replay first, limiter only for new work. */
function fakeCommands() {
  const created = new Map<string, { folder: { id: string; name: string; createdAt: string }; name: string }>();
  const createFolder = mock(
    async (_scope: unknown, name: string, mutation: { clientIdempotencyKey: string; beforeAccept?: () => Promise<void> }) => {
      const existing = created.get(mutation.clientIdempotencyKey);
      if (existing) {
        if (existing.name !== name) {
          throw new ExpectedDomainFailureError({ code: "operation_idempotency_conflict", kind: "conflict", message: "Key reused." });
        }
        return { folder: existing.folder, replayed: true };
      }
      await mutation.beforeAccept?.();
      const folder = { id: `folder-${created.size + 1}`, name, createdAt: "2026-10-29T00:00:00.000Z" };
      created.set(mutation.clientIdempotencyKey, { folder, name });
      return { folder, replayed: false };
    },
  );
  return { createFolder };
}

describe("folder creation", () => {
  test("needs an Idempotency-Key, validates the body, then creates once and replays", async () => {
    const app = libraryApp({ projectsCommands: fakeCommands() });
    const create = (headers: Record<string, string>, body: unknown) =>
      app.request("/api/library/folders", { method: "POST", headers, body: JSON.stringify(body) });

    const noKey = await create(json, { name: "Launch" });
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: "idempotency_key_required" });

    const invalid = await create({ ...json, "idempotency-key": "k-1" }, { name: 3 });
    expect(invalid.status).toBe(400);

    const first = await create({ ...json, "idempotency-key": "k-1" }, { name: "Launch" });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const body = (await first.json()) as { folder: { id: string } };

    const replay = await create({ ...json, "idempotency-key": "k-1" }, { name: "Launch" });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(body);

    const changed = await create({ ...json, "idempotency-key": "k-1" }, { name: "Other" });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: "operation_idempotency_conflict" });
  });

  test("an exhausted limiter refuses new work 429 but never a replay", async () => {
    let exhausted = false;
    const app = libraryApp(
      { projectsCommands: fakeCommands() },
      { rateLimit: () => (exhausted ? { allowed: false, availability: "available", retryAfterSeconds: 30 } : { allowed: true }) },
    );
    const create = () =>
      app.request("/api/library/folders", {
        method: "POST",
        headers: { ...json, "idempotency-key": "k-1" },
        body: JSON.stringify({ name: "Launch" }),
      });
    expect((await create()).status).toBe(201);
    exhausted = true;
    const replay = await create();
    expect(replay.status).toBe(200);
    const fresh = await app.request("/api/library/folders", {
      method: "POST",
      headers: { ...json, "idempotency-key": "k-2" },
      body: JSON.stringify({ name: "Another" }),
    });
    expect(fresh.status).toBe(429);
    expect(fresh.headers.get("retry-after")).toBe("30");
  });

  test("an unavailable limiter pauses new folders 503 mutations_unavailable", async () => {
    const app = libraryApp(
      { projectsCommands: fakeCommands() },
      { rateLimit: () => ({ allowed: true, availability: "unavailable" }) },
    );
    const response = await app.request("/api/library/folders", {
      method: "POST",
      headers: { ...json, "idempotency-key": "k-1" },
      body: JSON.stringify({ name: "Launch" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "mutations_unavailable" });
  });

  test("a viewer cannot create, rename or delete folders", async () => {
    const createFolder = mock();
    const renameFolder = mock();
    const deleteFolder = mock();
    const app = libraryApp(
      { projectsCommands: { createFolder }, workspaceLibraryService: { renameFolder, deleteFolder } },
      { context: workspaceContext({ role: "viewer" }) },
    );
    const create = await app.request("/api/library/folders", {
      method: "POST",
      headers: { ...json, "idempotency-key": "k-1" },
      body: JSON.stringify({ name: "Launch" }),
    });
    const rename = await app.request(`/api/library/folders/${FOLDER_ID}`, { method: "PATCH", headers: json, body: JSON.stringify({ name: "X" }) });
    const remove = await app.request(`/api/library/folders/${FOLDER_ID}`, { method: "DELETE", headers: signedInHeaders });
    expect([create.status, rename.status, remove.status]).toEqual([403, 403, 403]);
    expect(createFolder).not.toHaveBeenCalled();
    expect(renameFolder).not.toHaveBeenCalled();
    expect(deleteFolder).not.toHaveBeenCalled();
  });
});

describe("a taken folder name", () => {
  const taken = () =>
    new ExpectedDomainFailureError({
      code: "workspace_folder_name_taken",
      kind: "conflict",
      message: "A folder with this name already exists.",
    });

  test("create and rename answer 409 workspace_folder_name_taken", async () => {
    const app = libraryApp({
      projectsCommands: { createFolder: mock(async () => Promise.reject(taken())) },
      workspaceLibraryService: { renameFolder: mock(async () => Promise.reject(taken())) },
    });
    const create = await app.request("/api/library/folders", {
      method: "POST",
      headers: { ...json, "idempotency-key": "k-1" },
      body: JSON.stringify({ name: "Launch" }),
    });
    expect(create.status).toBe(409);
    expect(await create.json()).toMatchObject({
      error: "workspace_folder_name_taken",
      message: "A folder with this name already exists.",
    });
    const rename = await app.request(`/api/library/folders/${FOLDER_ID}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ name: "Launch" }),
    });
    expect(rename.status).toBe(409);
    expect(await rename.json()).toMatchObject({ error: "workspace_folder_name_taken" });
  });
});

describe("folder reads and edits", () => {
  test("lists folders with ISO dates and Project counts", async () => {
    const app = libraryApp({
      workspaceLibraryService: {
        listFolders: mock(async () => [
          { id: FOLDER_ID, name: "Launch", createdAt: new Date("2026-10-01T00:00:00Z"), _count: { projects: 3 } },
        ]),
      },
    });
    const response = await app.request("/api/workspace/folders", { headers: signedInHeaders });
    expect(await response.json()).toEqual({
      folders: [{ id: FOLDER_ID, name: "Launch", createdAt: "2026-10-01T00:00:00.000Z", projectCount: 3 }],
    });
  });

  test("rename and delete pass the validated folder, and a malformed folder id never reaches the service", async () => {
    const renameFolder = mock(async () => undefined);
    const deleteFolder = mock(async () => undefined);
    const app = libraryApp({ workspaceLibraryService: { renameFolder, deleteFolder } });
    const rename = await app.request(`/api/library/folders/${FOLDER_ID}`, { method: "PATCH", headers: json, body: JSON.stringify({ name: "Renamed" }) });
    expect(rename.status).toBe(200);
    expect(renameFolder).toHaveBeenCalledWith(expect.anything(), FOLDER_ID, "Renamed");
    const remove = await app.request(`/api/library/folders/${FOLDER_ID}`, { method: "DELETE", headers: signedInHeaders });
    expect(remove.status).toBe(200);
    expect(deleteFolder).toHaveBeenCalledWith(expect.anything(), FOLDER_ID);
    const malformed = await app.request("/api/library/folders/not-a-uuid", { method: "DELETE", headers: signedInHeaders });
    expect(malformed.status).toBe(400);
    expect(deleteFolder).toHaveBeenCalledTimes(1);
  });
});

describe("search", () => {
  test("workspace search passes the trimmed-by-service query; library search keeps its validator and project scope", async () => {
    const search = mock(async () => [{ id: "x" }]);
    const librarySearch = mock(async () => [{ id: "hit" }]);
    const app = libraryApp({
      workspaceLibraryService: { search },
      librarySearchService: { search: librarySearch },
    });
    const found = await app.request("/api/workspace/search?q=launch", { headers: signedInHeaders });
    expect(await found.json()).toEqual({ results: [{ id: "x" }] });
    expect(search).toHaveBeenCalledWith(expect.anything(), "launch");

    const tooShort = await app.request("/api/library/search?q=a", { headers: signedInHeaders });
    expect(tooShort.status).toBe(400);
    const scoped = await app.request(`/api/library/search?q=hello&limit=5&projectId=${PROJECT_ID}`, { headers: signedInHeaders });
    expect(scoped.status).toBe(200);
    expect(librarySearch).toHaveBeenCalledWith(expect.anything(), { query: "hello", limit: 5, projectIds: [PROJECT_ID] });
  });

  test("B-roll search answers unconfigured without validating, and refuses bad input once configured", async () => {
    const searchBrollVideos = mock(async () => [{ id: "clip" }]);
    const configured = libraryApp({ isPexelsConfigured: () => true, searchBrollVideos });
    const ok = await configured.request("/api/broll/search?query=ocean", { headers: signedInHeaders });
    expect(await ok.json()).toEqual({ configured: true, results: [{ id: "clip" }] });
    expect(searchBrollVideos).toHaveBeenCalledWith("ocean", "portrait");
    expect((await configured.request("/api/broll/search?query=", { headers: signedInHeaders })).status).toBe(400);

    const unconfigured = libraryApp({ isPexelsConfigured: () => false, searchBrollVideos });
    const empty = await unconfigured.request("/api/broll/search?query=ocean", { headers: signedInHeaders });
    expect(await empty.json()).toEqual({ configured: false, results: [] });
  });
});
