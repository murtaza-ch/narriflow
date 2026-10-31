import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJourneyFailure, prepareFileJourney, runFileJourney, type FileJourneyJournal } from "./deployed-file-journey";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "file-journey-")); directories.push(directory);
  const path = join(directory, "speech.webm"), bytes = Buffer.from("actual fixture bytes"); await writeFile(path, bytes);
  const apiOrigin = "https://api.fixture.invalid", apiKey = "nf_private_fixture", sessionToken = "private_fixture_clerk";
  const journal = prepareFileJourney({ apiOrigin, workspaceId: randomUUID(), source: { path, byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), durationSeconds: 146.147 } });
  const projectId = randomUUID(), sessionId = randomUUID(), queuedJobId = randomUUID(), taskId = randomUUID(), operationId = randomUUID();
  const clipIds = [randomUUID(), randomUUID(), randomUUID()];
  const storageUrl = "https://storage.fixture.invalid/assigned?private=fixture_grant_secret";
  const saved: FileJourneyJournal[] = [], calls: { path: string; method: string; body: any }[] = [];
  let finalized = false, notify = true, failNotify = false, loseGenerationReply = false, ready = true, wrongTaskBinding = false;
  const accepted = new Set<string>(), generationBodies: string[] = [];
  const persist = (value: FileJourneyJournal) => { saved.push(structuredClone(value)); };
  const fetcher = (async (target, init = {}) => {
    const url = new URL(String(target)), headers = new Headers(init.headers), method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ path: url.pathname, method, body });
    expect(init.redirect).toBe("manual"); expect(init.credentials).toBe("omit");
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.at(-1)!.uploadKey).toBe(journal.uploadKey); expect(saved.at(-1)!.generationKey).toBe(journal.generationKey);
    if (url.origin !== apiOrigin) {
      expect(url.href).toBe(storageUrl); expect(method).toBe("PUT"); expect(headers.has("Authorization")).toBe(false); expect(headers.has("Cookie")).toBe(false);
      expect(Buffer.from(init.body as ArrayBuffer)).toEqual(bytes);
      expect(saved.at(-1)!.projectId).toBe(projectId); expect(saved.at(-1)!.sessionId).toBe(sessionId);
      return new Response(null, { headers: { ETag: '"actual-fixture-etag"' } });
    }
    if (url.pathname.includes("/upload-sessions/")) {
      expect(headers.get("Authorization")).toBe(`Bearer ${apiKey}`);
      if (url.pathname.endsWith("/open")) {
        expect(body.clientIdempotencyKey).toBe(journal.uploadKey); expect(body.generationContext.contentPack.clipCountTarget).toBe(12);
        expect(body.generationContext.languageCode).toBe("en"); expect(body.generationContext.finishing).toBeUndefined();
        return Response.json(finalized ? { outcome: "queued_for_ingest", projectId, sessionId, queuedJobId } :
          { outcome: "uploading", projectId, sessionId, transfer: { kind: "single", contentType: "video/webm", grant: { url: storageUrl } } });
      }
      expect(url.pathname.endsWith("/finalize")).toBe(true);
      expect(body.sessionId).toBe(sessionId); expect(body.callback).toBeUndefined(); finalized = true;
      return Response.json({ outcome: "queued_for_ingest", projectId, sessionId, queuedJobId });
    }
    if (url.pathname.startsWith("/api/projects/")) {
      expect(headers.get("Authorization")).toBe(`Bearer ${sessionToken}`); expect(headers.get("X-Workspace-Id")).toBe(journal.workspaceId);
      expect(finalized).toBe(true);
      if (url.pathname.endsWith("/notify-preference")) {
        expect(body).toEqual({ notifyOnComplete: false });
        if (failNotify) return Response.json({ error: "controlled" }, { status: 503 });
        notify = false; return Response.json({ ok: true });
      }
      return Response.json({ project: { id: projectId, notifyOnComplete: notify, ingestStatus: ready ? "ready" : "queued", sourceDurationSeconds: 146.147 } });
    }
    expect(url.pathname).toBe("/mcp"); expect(headers.get("Authorization")).toBe(`Bearer ${apiKey}`); expect(notify).toBe(false);
    expect(headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
    expect(body.params._meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]).toEqual({});
    let result: Record<string, unknown>;
    if (body.method === "tasks/get") {
      expect(body.params.taskId).toBe(taskId); expect(headers.get("MCP-Name")).toBe(taskId); result = { taskId, status: "completed", resultType: "complete" };
    } else if (body.params.name === "narriflow_generate_clips") {
      expect(body.params.arguments.forceRegenerate).toBe(false); expect(body.params.arguments.finishing).toBeUndefined();
      expect(body.params.arguments.projectId).toBe(projectId); expect(body.params.arguments.clientIdempotencyKey).toBe(journal.generationKey);
      expect(body.params.arguments.generation).toEqual(journal.generation);
      accepted.add(body.params.arguments.clientIdempotencyKey); generationBodies.push(String(init.body));
      if (loseGenerationReply) { loseGenerationReply = false; throw new Error("controlled lost reply; private url must not be journaled"); }
      result = { taskId, status: "working", resultType: "task", _meta: { "narriflow/operation": { workspaceId: wrongTaskBinding ? randomUUID() : journal.workspaceId, projectId, domainKind: "generation", domainId: operationId } } };
    } else {
      expect(body.params.name).toBe("narriflow_get_operation"); expect(body.params.arguments.operation).toEqual({ kind: "generation", id: operationId });
      result = { resultType: "complete", structuredContent: { data: { operation: { kind: "generation", id: operationId }, state: "completed", stage: null, progress: 1,
        items: clipIds.map(id => ({ kind: "clip", id, state: "completed", failureCode: null })), results: { projectId, clipIds, exportId: null }, notices: [], failureCode: null,
        reviewUrl: "https://private-review.fixture.invalid/never-journal" } } };
    }
    return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const run = (phase: "upload" | "generate" | "status") => runFileJourney(phase, { apiOrigin, apiKey, sessionToken, journal, persist }, { fetch: fetcher, delay: async () => {} });
  return { journal, calls, saved, run, accepted, generationBodies, taskId,
    setFailNotify: (value: boolean) => { failNotify = value; }, setLostGeneration: () => { loseGenerationReply = true; }, setReady: (value: boolean) => { ready = value; },
    setWrongTaskBinding: () => { wrongTaskBinding = true; } };
}

test("fixture-only real uploader journals identities before PUT, disables notifications before MCP and reports actual selection", async () => {
  const f = await fixture();
  expect(await f.run("upload")).toMatchObject({ status: "accepted", notificationDisabled: true });
  expect(await f.run("generate")).toMatchObject({ status: "accepted", positiveTask: true, requestedClips: 12 });
  expect(f.journal.taskId).toBe(f.taskId);
  expect(await f.run("status")).toMatchObject({ status: "completed", requestedClips: 12, actualClips: 3, selectionBelowRequested: true, completedItems: 3 });
  const serialized = JSON.stringify(f.saved);
  for (const forbidden of ["https:", "private_fixture_clerk", "nf_private_fixture", "fixture_grant_secret", "never-journal"]) expect(serialized).not.toContain(forbidden);
  expect(f.calls.map(call => call.method).every(method => ["POST", "PUT", "GET"].includes(method))).toBe(true);
});

test("lost MCP acceptance reply retries the same frozen key and exact request, producing one logical fixture acceptance", async () => {
  const f = await fixture(); await f.run("upload"); f.setLostGeneration();
  await expect(f.run("generate")).rejects.toThrow("controlled lost reply");
  expect(await f.run("generate")).toMatchObject({ status: "accepted", positiveTask: true });
  expect(f.accepted.size).toBe(1); expect(f.generationBodies[0]).toBe(f.generationBodies[1]);
});

test("notification preference failure resumes the already-finalized Upload Session without another PUT", async () => {
  const f = await fixture(); f.setFailNotify(true);
  await expect(f.run("upload")).rejects.toBeInstanceOf(FileJourneyFailure);
  expect(f.journal.notificationDisabledAt).toBeUndefined(); expect(f.journal.queuedJobId).toBeString();
  f.setFailNotify(false); expect(await f.run("upload")).toMatchObject({ notificationDisabled: true });
  expect(f.calls.filter(call => call.path === "/assigned")).toHaveLength(1);
});

test("a finite source wait reports pending and cannot call generation before measured readiness", async () => {
  const f = await fixture(); await f.run("upload"); f.setReady(false);
  expect(await f.run("generate")).toMatchObject({ status: "pending", reason: "source_not_ready", requests: 61 });
  expect(f.calls.filter(call => call.path === "/mcp")).toHaveLength(0);
});

test("a changed source refuses before networking and keeps its original upload key", async () => {
  const f = await fixture(), key = f.journal.uploadKey; await writeFile(f.journal.source.path, "changed");
  await expect(f.run("upload")).rejects.toThrow("source_changed"); expect(f.calls).toEqual([]); expect(f.journal.uploadKey).toBe(key);
});

test("a Task bound to another Workspace cannot become a positive acceptance fixture", async () => {
  const f = await fixture(); await f.run("upload"); f.setWrongTaskBinding();
  await expect(f.run("generate")).rejects.toThrow("generation_task_binding_invalid"); expect(f.journal.taskId).toBeUndefined();
});
