import { expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
	applyEditorAction,
  editorDocumentSchema,
  editorDocumentsEqual,
  studioEditsSchema,
  type EditorDocument,
} from "@narriflow/validators";
import {
  createStudioEditingSession,
  type StudioCloudSaveOutcome,
  type StudioCloudResetOutcome,
  type StudioDraftRecord,
  type StudioSessionDependencies,
  type StudioSessionSnapshot,
} from "./studio-editing-session";

function makeDocument(brollUrl: string | null = null): EditorDocument {
  return editorDocumentSchema.parse({
    version: 2,
    clipStartSec: 10,
    clipEndSec: 40,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl,
    deletedRanges: [],
  });
}

function makeTimedDocument(): EditorDocument {
  const sceneId = "8ab9d330-688f-4574-932c-27ac661245c1";
  return editorDocumentSchema.parse({
    version: 2,
    ...makeDocument(),
    sceneBlocks: [{
      schemaVersion: 1,
      id: sceneId,
      anchorSec: 4,
      durationSec: 2,
      content: { kind: "color", color: "#111827" },
      motion: { entrance: "fade", exit: "scale-out" },
      templateSnapshot: null,
    }],
    censorSegments: [{
      schemaVersion: 1,
      id: "dbb670b3-e28a-4514-bf2d-63e56608a4d0",
      sourceWordIds: ["word-1"],
      sourceStartSec: 14,
      sourceEndSec: 14.5,
      treatment: "beep",
      paddingSec: 0.1,
      beepSettings: { frequencyHz: 1_000, levelDb: -12 },
      captionMaskPolicy: null,
      suggestionFingerprint: "a".repeat(64),
      policyVersion: "profanity-v1",
      enabled: true,
    }],
    mediaMotions: [{
      schemaVersion: 1,
      id: "2adf79cc-35b2-4de5-85dc-c9ed197763e4",
      target: { kind: "scene_block", sceneBlockId: sceneId },
      startSec: 4,
      endSec: 6,
      entrance: "scale-in",
      exit: "fade",
      enabled: true,
    }],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ControlledCloud {
  readonly saves: Array<{
    baseRevision: number;
    document: EditorDocument;
    result: ReturnType<typeof deferred<StudioCloudSaveOutcome>>;
  }> = [];
  readonly resets: Array<{
    baseRevision: number;
    result: ReturnType<typeof deferred<StudioCloudResetOutcome>>;
  }> = [];
  readonly keepalives: Array<{
    baseRevision: number;
    document: EditorDocument;
  }> = [];
  private nextHeadLoad: ReturnType<
    typeof deferred<{ revision: number; document: EditorDocument }>
  > | null = null;

  constructor(
    private revision: number,
    private document: EditorDocument,
  ) {}

  loadHead = async () => {
    const pending = this.nextHeadLoad;
    if (pending) {
      this.nextHeadLoad = null;
      return pending.promise;
    }
    return {
      revision: this.revision,
      document: structuredClone(this.document),
    };
  };

  save: StudioSessionDependencies["cloud"]["save"] = (input) => {
    const result = deferred<StudioCloudSaveOutcome>();
    this.saves.push({
      baseRevision: input.baseRevision,
      document: structuredClone(input.document),
      result,
    });
    if (
      input.baseRevision !== this.revision &&
      editorDocumentsEqual(input.document, this.document)
    ) {
      result.resolve({
        kind: "saved",
        revision: this.revision,
        document: structuredClone(this.document),
      });
    }
    return result.promise;
  };

  acknowledge(index: number, revision: number): void {
    const save = this.saves[index];
    if (!save) throw new Error(`Missing save ${index}`);
    this.revision = revision;
    this.document = structuredClone(save.document);
    save.result.resolve({
      kind: "saved",
      revision,
      document: structuredClone(save.document),
    });
  }

  respond(index: number, outcome: StudioCloudSaveOutcome): void {
    const save = this.saves[index];
    if (!save) throw new Error(`Missing save ${index}`);
    save.result.resolve(outcome);
  }

  setHead(revision: number, document: EditorDocument): void {
    this.revision = revision;
    this.document = structuredClone(document);
  }

  deferHeadLoad() {
    const result = deferred<{ revision: number; document: EditorDocument }>();
    this.nextHeadLoad = result;
    return result;
  }

  commitButLoseResponse(index: number, revision: number): void {
    const save = this.saves[index];
    if (!save) throw new Error(`Missing save ${index}`);
    this.revision = revision;
    this.document = structuredClone(save.document);
    save.result.resolve({ kind: "transient", reason: "network" });
  }

  reset: StudioSessionDependencies["cloud"]["reset"] = (input) => {
    const result = deferred<StudioCloudResetOutcome>();
    this.resets.push({ baseRevision: input.baseRevision, result });
    return result.promise;
  };

  keepalive: StudioSessionDependencies["cloud"]["keepalive"] = (input) => {
    this.keepalives.push({
      baseRevision: input.baseRevision,
      document: structuredClone(input.document),
    });
  };
}

class ManualRuntime {
  nowMs = 100;
  online = true;
  private nextTimerId = 1;
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void }
  >();
  private readonly onlineListeners = new Set<(online: boolean) => void>();

  now = () => this.nowMs;
  createId = () => "writer";
  random = () => 0.5;
  isOnline = () => this.online;
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };
  clearTimeout = (id: number) => {
    this.timers.delete(id);
  };
  subscribeOnline = (listener: (online: boolean) => void) => {
    this.onlineListeners.add(listener);
    return () => this.onlineListeners.delete(listener);
  };

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.nowMs = due[1].at;
      due[1].callback();
    }
    this.nowMs = target;
  }

  setOnline(online: boolean): void {
    this.online = online;
    for (const listener of this.onlineListeners) listener(online);
  }
}

function waitForSnapshot(
  session: ReturnType<typeof createStudioEditingSession>,
  predicate: (snapshot: StudioSessionSnapshot) => boolean,
): Promise<StudioSessionSnapshot> {
  const current = session.getSnapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsubscribe = session.subscribe(() => {
      const next = session.getSnapshot();
      if (!predicate(next)) return;
      unsubscribe();
      resolve(next);
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition did not become true");
}

async function makeSession(
  cloud: ControlledCloud,
  runtime = new ManualRuntime(),
  ownership: "writer" | "reader" | "degraded" = "writer",
  drafts: StudioSessionDependencies["drafts"] = {
    load: async () => null,
    write: async () => "written",
    remove: async () => "removed",
  },
) {
  const session = createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 3,
      document: makeDocument(),
      segments: [],
    },
    {
      drafts,
      coordination: {
        start: async () => ({ kind: ownership, generation: 1 }),
        takeOver: async () => ({
          kind: "acquired",
          generation: 2,
          forced: false,
        }),
        close: () => undefined,
      },
      cloud,
      runtime,
    },
  );
  await waitForSnapshot(session, (snapshot) => snapshot.status === "ready");
  return session;
}

test("checkpoints every timed-edit family without narrowing the document", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud);
  const timed = makeTimedDocument();
  session.dispatch({ type: "document.edit", action: {
    type: "insertSceneBlock",
    scene: timed.sceneBlocks[0]!,
  } });
  session.dispatch({ type: "document.edit", action: {
    type: "insertCensorSegment",
    segment: timed.censorSegments[0]!,
  } });
  session.dispatch({ type: "document.edit", action: {
    type: "insertMediaMotion",
    motion: timed.mediaMotions[0]!,
  } });

  const checkpoint = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 1);
  expect(cloud.saves[0]?.document).toEqual(timed);
  cloud.acknowledge(0, 4);
  expect(await checkpoint).toEqual({ kind: "cloud-current", revision: 4 });
});

test("adopts one server-committed generated placement as one undoable cloud-current step", async () => {
  const runtime = new ManualRuntime();
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, runtime);
  expect(await session.perform({ type: "prepare-external-commit" })).toEqual({
    kind: "external-commit-prepared",
    revision: 3,
  });
	const placement = {
      id: "00000000-0000-4000-8000-000000000001",
      asset: {
        kind: "visual_asset",
        id: "00000000-0000-4000-8000-000000000002",
        fingerprint: "a".repeat(64),
      },
      provenance: "generated",
      mediaKind: "image",
      startSec: 2,
      endSec: 5,
      sourceStartSec: null,
      sourceEndSec: null,
	} as const;
	const action = { type: "insertBrollPlacement", placement } as const;
	const inserted = applyEditorAction(makeDocument(), action);
	expect(session.dispatch({
		type: "document.edit",
		action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/race.mp4" },
	})).toEqual({ accepted: false, reason: "starting" });
  cloud.setHead(4, inserted);

  expect(await session.perform({
    type: "adopt-external-document-edit",
    baseRevision: 3,
		committedRevision: 4,
		action,
    document: inserted,
  })).toEqual({ kind: "external-document-edit-adopted", revision: 4 });
  expect(session.getSnapshot()).toMatchObject({
    document: { brollPlacements: [{ id: "00000000-0000-4000-8000-000000000001" }] },
    history: { canUndo: true, canRedo: false },
    cloud: { state: "current", revision: 4, dirty: false },
  });
  runtime.advance(5_000);
  expect(cloud.saves).toHaveLength(0);

  session.dispatch({ type: "history.undo" });
  runtime.advance(1_500);
  await waitUntil(() => cloud.saves.length === 1);
  expect(cloud.saves[0]).toMatchObject({
    baseRevision: 4,
    document: { brollPlacements: [] },
  });
  cloud.acknowledge(0, 5);
  await waitForSnapshot(session, (snapshot) => snapshot.cloud.state === "current");

  session.dispatch({ type: "history.redo" });
  runtime.advance(1_500);
  await waitUntil(() => cloud.saves.length === 2);
  expect(cloud.saves[1]).toMatchObject({
    baseRevision: 5,
    document: { brollPlacements: [{ id: "00000000-0000-4000-8000-000000000001" }] },
  });
});

test("checkpoints before locking an external mutation and refuses conflict or degraded ownership", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/local.mp4" },
  });

	const preparation = session.perform({ type: "prepare-external-commit" });
  await waitUntil(() => cloud.saves.length === 1);
	cloud.acknowledge(0, 4);
	expect(await preparation).toEqual({
		kind: "external-commit-prepared",
		revision: 4,
	});
	expect(session.getSnapshot().status).toBe("starting");
	expect(await session.perform({ type: "abort-external-commit" })).toEqual({
		kind: "external-commit-aborted",
	});
	expect(session.getSnapshot().status).toBe("ready");

	const degraded = await makeSession(new ControlledCloud(3, makeDocument()), new ManualRuntime(), "degraded");
	expect(await degraded.perform({ type: "prepare-external-commit" })).toEqual({
		kind: "cloud-blocked",
		reason: "read-only",
	});
});

test("verifies the exact external editor action and converges a mismatched response", async () => {
	const cloud = new ControlledCloud(3, makeDocument());
	const session = await makeSession(cloud);
	const action = {
		type: "setBrollUrl",
		brollUrl: "https://cdn.example.com/server.mp4",
	} as const;
	const inserted = applyEditorAction(makeDocument(), action);
	expect(await session.perform({ type: "prepare-external-commit" })).toEqual({
		kind: "external-commit-prepared",
		revision: 3,
	});
	cloud.setHead(4, inserted);
	expect(await session.perform({
		type: "adopt-external-document-edit",
		baseRevision: 3,
		committedRevision: 4,
		action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/tampered.mp4" },
		document: inserted,
	})).toEqual({
		kind: "cloud-blocked",
		reason: "semantic-rejection",
		code: "external_document_mismatch",
	});
	expect(session.getSnapshot()).toMatchObject({
		status: "ready",
		document: { brollUrl: "https://cdn.example.com/server.mp4" },
		cloud: { revision: 4, dirty: false },
	});
});

test("ignores an older document-generation response and serializes one latest follow-up", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud);

  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
  });
  const checkpoint = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 1);
  expect(cloud.saves).toHaveLength(1);

  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/b.mp4" },
  });
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/c.mp4" },
  });
  expect(cloud.saves).toHaveLength(1);

  cloud.acknowledge(0, 4);
  await waitUntil(() => cloud.saves.length === 2);
  expect(session.getSnapshot().document.brollUrl).toBe(
    "https://cdn.example.com/c.mp4",
  );
  expect(cloud.saves[1]?.baseRevision).toBe(4);
  expect(cloud.saves[1]?.document.brollUrl).toBe(
    "https://cdn.example.com/c.mp4",
  );

  cloud.acknowledge(1, 5);
  expect(await checkpoint).toEqual({ kind: "cloud-current", revision: 5 });
  expect(session.getSnapshot().cloud).toMatchObject({
    state: "current",
    revision: 5,
    dirty: false,
  });
});

test("retries a lost response with the same idempotent checkpoint envelope", async () => {
  const runtime = new ManualRuntime();
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, runtime);
  session.dispatch({
    type: "document.edit",
    action: {
      type: "setBrollUrl",
      brollUrl: "https://cdn.example.com/committed.mp4",
    },
  });
  const checkpoint = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 1);

  cloud.commitButLoseResponse(0, 4);
  await waitForSnapshot(
    session,
    (snapshot) => snapshot.cloud.state === "retrying",
  );
  runtime.advance(999);
  await Promise.resolve();
  expect(cloud.saves).toHaveLength(1);
  runtime.advance(1);
  await waitUntil(() => cloud.saves.length === 2);
  expect(cloud.saves[1]).toMatchObject({
    baseRevision: 3,
    document: { brollUrl: "https://cdn.example.com/committed.mp4" },
  });

  expect(await checkpoint).toEqual({ kind: "cloud-current", revision: 4 });
  expect(cloud.saves).toHaveLength(2);
});

test("reset blocks edits, drains the checkpoint chain, and requires reload", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
  });

  const reset = session.perform({ type: "reset-to-original" });
  expect(
    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/b.mp4" },
    }),
  ).toEqual({ accepted: false, reason: "starting" });
  await waitUntil(() => cloud.saves.length === 1);
  expect(cloud.resets).toHaveLength(0);

  cloud.acknowledge(0, 4);
  await waitUntil(() => cloud.resets.length === 1);
  expect(cloud.resets[0]?.baseRevision).toBe(4);
  cloud.resets[0]?.result.resolve({
    kind: "reset",
    revision: 5,
    document: makeDocument(),
  });

  expect(await reset).toEqual({
    kind: "reset-complete",
    revision: 5,
    document: makeDocument(),
    reloadRequired: true,
  });
  expect(session.getSnapshot().status).toBe("closed");
});

test("retries a transient reset and lets explicit Save wake it immediately", async () => {
  const runtime = new ManualRuntime();
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, runtime);
  const reset = session.perform({ type: "reset-to-original" });
  await waitUntil(() => cloud.resets.length === 1);
  cloud.resets[0]?.result.resolve({ kind: "transient", reason: "server" });
  await waitForSnapshot(session, (snapshot) => snapshot.cloud.state === "retrying");
  expect(cloud.resets).toHaveLength(1);

  expect(await session.perform({ type: "checkpoint-cloud" })).toEqual({
    kind: "cloud-current",
    revision: 3,
  });
  await waitUntil(() => cloud.resets.length === 2);
  cloud.resets[1]?.result.resolve({
    kind: "reset",
    revision: 4,
    document: makeDocument(),
  });
  expect(await reset).toMatchObject({
    kind: "reset-complete",
    revision: 4,
    reloadRequired: true,
  });
});

test("reconnect wakes an offline reset without waiting for backoff", async () => {
  const runtime = new ManualRuntime();
  runtime.online = false;
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, runtime);
  const reset = session.perform({ type: "reset-to-original" });
  await waitForSnapshot(session, (snapshot) => snapshot.cloud.state === "offline");
  expect(cloud.resets).toHaveLength(0);

  runtime.setOnline(true);
  await waitUntil(() => cloud.resets.length === 1);
  cloud.resets[0]?.result.resolve({
    kind: "reset",
    revision: 4,
    document: makeDocument(),
  });
  expect(await reset).toMatchObject({ kind: "reset-complete", revision: 4 });
});

test("close is idempotent and never starts keepalive beside a regular save", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
  });
  const checkpoint = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 1);

  expect(await session.perform({ type: "close", reason: "pagehide" })).toEqual({
    kind: "closed",
  });
  expect(cloud.keepalives).toHaveLength(0);
  cloud.acknowledge(0, 4);
  await Promise.resolve();
  expect(session.getSnapshot().status).toBe("closed");
  expect(await session.perform({ type: "close", reason: "unmount" })).toEqual({
    kind: "closed",
  });
  expect(await checkpoint).toEqual({ kind: "cloud-blocked", reason: "closed" });
});

test("close attempts one keepalive only when dirty and no regular save is active", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
  });

  await session.perform({ type: "close", reason: "pagehide" });
  expect(cloud.keepalives).toEqual([
    {
      baseRevision: 3,
      document: expect.objectContaining({
        brollUrl: "https://cdn.example.com/a.mp4",
      }),
    },
  ]);
});

test("close rejects new edits while its final Device Draft is still writing", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const draftWrite = deferred<"written" | "stale">();
  const session = await makeSession(
    cloud,
    new ManualRuntime(),
    "writer",
    {
      load: async () => null,
      write: async () => draftWrite.promise,
      remove: async () => "removed",
    },
  );
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
  });
  const close = session.perform({ type: "close", reason: "navigation" });
  expect(
    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/b.mp4" },
    }),
  ).toEqual({ accepted: false, reason: "closed" });
  draftWrite.resolve("written");
  expect(await close).toEqual({ kind: "closed" });
});

test("reconnect wakes an offline checkpoint immediately", async () => {
  const runtime = new ManualRuntime();
  runtime.online = false;
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, runtime);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
  });
  const checkpoint = session.perform({ type: "checkpoint-cloud" });
  await waitForSnapshot(session, (snapshot) => snapshot.cloud.state === "offline");
  expect(cloud.saves).toHaveLength(0);

  runtime.setOnline(true);
  await waitUntil(() => cloud.saves.length === 1);
  cloud.acknowledge(0, 4);
  expect(await checkpoint).toEqual({ kind: "cloud-current", revision: 4 });
});

test("explicit Save wakes a retry immediately without creating overlap", async () => {
  const runtime = new ManualRuntime();
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, runtime);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
  });
  const firstWaiter = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 1);
  cloud.respond(0, { kind: "transient", reason: "server" });
  await waitForSnapshot(session, (snapshot) => snapshot.cloud.state === "retrying");

  const explicitSave = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 2);
  expect(cloud.saves[1]?.baseRevision).toBe(3);
  cloud.acknowledge(1, 4);
  expect(await Promise.all([firstWaiter, explicitSave])).toEqual([
    { kind: "cloud-current", revision: 4 },
    { kind: "cloud-current", revision: 4 },
  ]);
});

test("a semantic rejection preserves editing and a corrected version can checkpoint", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/bad.mp4" },
  });
  const rejected = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 1);
  cloud.respond(0, { kind: "rejected", code: "unsafe_media_url" });
  expect(await rejected).toEqual({
    kind: "cloud-blocked",
    reason: "semantic-rejection",
    code: "unsafe_media_url",
  });
  expect(session.getSnapshot()).toMatchObject({
    durability: { device: "durable" },
    capabilities: { mutate: true },
    cloud: { state: "rejected", dirty: true },
  });

  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/good.mp4" },
  });
  const corrected = session.perform({ type: "prepare-cloud-revision" });
  await waitUntil(() => cloud.saves.length === 2);
  cloud.acknowledge(1, 4);
  expect(await corrected).toEqual({ kind: "cloud-prepared", revision: 4 });
});

test("merges disjoint cloud changes after a revision conflict and resets history", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/local.mp4" },
  });
  const remote = makeDocument();
  remote.captionPreset = { ...remote.captionPreset, fontSize: 42 };
  cloud.setHead(4, remote);

  const checkpoint = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 1);
  cloud.respond(0, { kind: "revision-conflict", currentRevision: 4 });

  await waitUntil(() => cloud.saves.length === 2);
  expect(cloud.saves[1]).toMatchObject({
    baseRevision: 4,
    document: {
      brollUrl: "https://cdn.example.com/local.mp4",
      captionPreset: { fontSize: 42 },
    },
  });
  expect(session.getSnapshot().history).toEqual({ canUndo: false, canRedo: false });

  cloud.acknowledge(1, 5);
  expect(await checkpoint).toEqual({ kind: "cloud-current", revision: 5 });
});

test("blocks edits for ordered-array conflicts and keeping cloud starts fresh", async () => {
  const removed: Array<{ key: string; generation: number }> = [];
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, new ManualRuntime(), "writer", {
    load: async () => null,
    write: async () => "written",
    remove: async (key, generation) => {
      removed.push({ key, generation });
      return "removed";
    },
  });
  session.dispatch({
    type: "document.edit",
    action: {
      type: "setDeletedRanges",
      ranges: [{ startSec: 12, endSec: 13 }],
    },
  });
  const remote = makeDocument();
  remote.deletedRanges = [{ startSec: 20, endSec: 21 }];
  cloud.setHead(4, remote);

  const checkpoint = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 1);
  cloud.respond(0, { kind: "revision-conflict", currentRevision: 4 });

  expect(await checkpoint).toEqual({
    kind: "cloud-blocked",
    reason: "unresolved-conflict",
  });
  expect(session.getSnapshot()).toMatchObject({
    status: "conflict",
    recovery: { kind: "conflict", conflictPaths: ["deletedRanges"] },
    durability: { device: "durable" },
    cloud: { revision: 4, dirty: true },
    capabilities: { mutate: false },
  });
  expect(
    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/nope.mp4" },
    }),
  ).toEqual({ accepted: false, reason: "conflict" });
  expect(await session.perform({ type: "checkpoint-cloud" })).toEqual({
    kind: "cloud-blocked",
    reason: "unresolved-conflict",
  });

  expect(await session.perform({ type: "resolve-conflict", choice: "cloud" })).toEqual({
    kind: "conflict-resolved",
    choice: "cloud",
  });
  expect(session.getSnapshot()).toMatchObject({
    document: { deletedRanges: [{ startSec: 20, endSec: 21 }] },
    status: "ready",
    history: { canUndo: false, canRedo: false },
    cloud: { state: "current", revision: 4, dirty: false },
  });
  expect(removed).toContainEqual({ key: "project:clip", generation: 1 });
});

test("refreshes and converges a newer cloud head before bfcache editing resumes", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const runtime = new ManualRuntime();
  const session = await makeSession(cloud, runtime);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/local.mp4" },
  });
  const remote = makeDocument();
  remote.captionPreset = { ...remote.captionPreset, fontSize: 48 };
  const head = cloud.deferHeadLoad();

  const resume = session.perform({ type: "resume" });
  expect(
    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/late.mp4" },
    }),
  ).toEqual({ accepted: false, reason: "starting" });
  head.resolve({ revision: 4, document: remote });

  expect(await resume).toEqual({
    kind: "cloud-refreshed",
    revision: 4,
    convergence: "merged",
  });
  expect(session.getSnapshot()).toMatchObject({
    document: {
      brollUrl: "https://cdn.example.com/local.mp4",
      captionPreset: { fontSize: 48 },
    },
    status: "ready",
    history: { canUndo: false, canRedo: false },
    cloud: { revision: 4, dirty: true },
  });
  runtime.advance(1_500);
  await waitUntil(() => cloud.saves.length === 1);
  expect(cloud.saves[0]).toMatchObject({
    baseRevision: 4,
    document: {
      brollUrl: "https://cdn.example.com/local.mp4",
      captionPreset: { fontSize: 48 },
    },
  });
});

test("keeps resume blocked and retries a stale cloud head", async () => {
  const runtime = new ManualRuntime();
  const cloud = new ControlledCloud(
    2,
    makeDocument("https://cdn.example.com/stale.mp4"),
  );
  const session = await makeSession(cloud, runtime);
  const resume = session.perform({ type: "resume" });
  await waitForSnapshot(session, (snapshot) => snapshot.cloud.state === "retrying");
  expect(session.getSnapshot()).toMatchObject({
    status: "starting",
    capabilities: { mutate: false },
    document: { brollUrl: null },
    cloud: { revision: 3 },
  });

  cloud.setHead(4, makeDocument("https://cdn.example.com/fresh.mp4"));
  runtime.advance(999);
  await Promise.resolve();
  expect(session.getSnapshot().status).toBe("starting");
  runtime.advance(1);

  expect(await resume).toEqual({
    kind: "cloud-refreshed",
    revision: 4,
    convergence: "current",
  });
  expect(session.getSnapshot()).toMatchObject({
    status: "ready",
    document: { brollUrl: "https://cdn.example.com/fresh.mp4" },
    cloud: { revision: 4, state: "current", dirty: false },
  });
});

test("keeping device rebases the whole document and resumes checkpointing", async () => {
  const written: StudioDraftRecord[] = [];
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, new ManualRuntime(), "writer", {
    load: async () => null,
    write: async (record) => {
      written.push(structuredClone(record));
      return "written";
    },
    remove: async () => "removed",
  });
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/device.mp4" },
  });
  const remote = makeDocument("https://cdn.example.com/cloud.mp4");
  cloud.setHead(4, remote);
  const conflictedCheckpoint = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 1);
  cloud.respond(0, { kind: "revision-conflict", currentRevision: 4 });
  expect(await conflictedCheckpoint).toEqual({
    kind: "cloud-blocked",
    reason: "unresolved-conflict",
  });

  expect(await session.perform({ type: "resolve-conflict", choice: "device" })).toEqual({
    kind: "conflict-resolved",
    choice: "device",
  });
  expect(session.getSnapshot()).toMatchObject({
    document: { brollUrl: "https://cdn.example.com/device.mp4" },
    status: "ready",
    history: { canUndo: false, canRedo: false },
    cloud: { revision: 4, dirty: true },
  });

  const rebasedCheckpoint = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 2);
  expect(cloud.saves[1]).toMatchObject({
    baseRevision: 4,
    document: { brollUrl: "https://cdn.example.com/device.mp4" },
  });
  expect(written.at(-1)).toMatchObject({
    baseRevision: 4,
    baseDocument: { brollUrl: "https://cdn.example.com/cloud.mp4" },
    document: { brollUrl: "https://cdn.example.com/device.mp4" },
  });
  cloud.acknowledge(1, 5);
  expect(await rebasedCheckpoint).toEqual({ kind: "cloud-current", revision: 5 });
});

test("ignores a cloud refresh response from a closed session generation", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud);
  const head = cloud.deferHeadLoad();
  const resume = session.perform({ type: "resume" });
  await session.perform({ type: "close", reason: "navigation" });

  head.resolve({
    revision: 4,
    document: makeDocument("https://cdn.example.com/stale.mp4"),
  });

  expect(await resume).toEqual({ kind: "cloud-blocked", reason: "closed" });
  expect(session.getSnapshot()).toMatchObject({
    status: "closed",
    document: { brollUrl: null },
    cloud: { revision: 3 },
  });
});

test("keeps cloud editing available when obsolete draft cleanup is degraded", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, new ManualRuntime(), "writer", {
    load: async () => null,
    write: async () => "written",
    remove: async () => {
      throw new Error("IndexedDB unavailable");
    },
  });
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/device.mp4" },
  });
  cloud.setHead(4, makeDocument("https://cdn.example.com/cloud.mp4"));
  const checkpoint = session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => cloud.saves.length === 1);
  cloud.respond(0, { kind: "revision-conflict", currentRevision: 4 });
  await checkpoint;

  expect(await session.perform({ type: "resolve-conflict", choice: "cloud" })).toEqual({
    kind: "conflict-resolved-degraded",
    choice: "cloud",
    reason: "device-draft-unavailable",
  });
  expect(session.getSnapshot()).toMatchObject({
    status: "ready",
    document: { brollUrl: "https://cdn.example.com/cloud.mp4" },
    durability: { device: "degraded", protectsNavigation: true },
    cloud: { state: "current", revision: 4, dirty: false },
    capabilities: { mutate: true },
  });
});

for (const terminal of [
  {
    outcome: { kind: "authentication-lost" } as const,
    state: "authentication-lost" as const,
    reason: "authentication-lost" as const,
  },
  {
    outcome: { kind: "missing" } as const,
    state: "missing" as const,
    reason: "missing" as const,
  },
]) {
  test(`exposes ${terminal.state} as a distinct terminal cloud state`, async () => {
    const cloud = new ControlledCloud(3, makeDocument());
    const session = await makeSession(cloud);
    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
    });
    const checkpoint = session.perform({ type: "checkpoint-cloud" });
    await waitUntil(() => cloud.saves.length === 1);
    cloud.respond(0, terminal.outcome);

    expect(await checkpoint).toEqual({
      kind: "cloud-blocked",
      reason: terminal.reason,
    });
    expect(session.getSnapshot().cloud.state).toBe(terminal.state);
  });
}

test("prepares an already-current revision from a clean read-only session", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, new ManualRuntime(), "reader");

  expect(await session.perform({ type: "prepare-cloud-revision" })).toEqual({
    kind: "cloud-prepared",
    revision: 3,
  });
  expect(cloud.saves).toHaveLength(0);
});

test("waits for startup recovery before preparing the exact cloud revision", async () => {
  const cloudDocument = makeDocument();
  const recoveredDocument = makeDocument(
    "https://cdn.example.com/recovered.mp4",
  );
  const draftLoad = deferred<StudioDraftRecord | null>();
  const cloud = new ControlledCloud(3, cloudDocument);
  const runtime = new ManualRuntime();
  const session = createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 3,
      document: cloudDocument,
      segments: [],
    },
    {
      drafts: {
        load: async () => draftLoad.promise,
        write: async () => "written",
        remove: async () => "removed",
      },
      coordination: {
        start: async () => ({ kind: "writer", generation: 2 }),
        takeOver: async () => ({
          kind: "acquired",
          generation: 3,
          forced: false,
        }),
        close: () => undefined,
      },
      cloud,
      runtime,
    },
  );
  let settled = false;
  const prepared = session
    .perform({ type: "prepare-cloud-revision" })
    .then((result) => {
      settled = true;
      return result;
    });
  await Promise.resolve();
  expect(settled).toBe(false);

  draftLoad.resolve({
    formatVersion: 2,
    key: "project:clip",
    projectId: "project",
    clipId: "clip",
    baseRevision: 3,
    baseDocument: cloudDocument,
    document: recoveredDocument,
    updatedAt: 90,
    writerId: "prior-writer",
    ownershipGeneration: 1,
  });
  await waitUntil(() => cloud.saves.length === 1);
  expect(cloud.saves[0]?.document.brollUrl).toBe(
    "https://cdn.example.com/recovered.mp4",
  );
  cloud.acknowledge(0, 4);
  expect(await prepared).toEqual({ kind: "cloud-prepared", revision: 4 });
});

test("makes the Device Draft durable before starting its cloud checkpoint", async () => {
  const cloud = new ControlledCloud(3, makeDocument());
  const draftWrite = deferred<"written" | "stale">();
  let writes = 0;
  const session = await makeSession(
    cloud,
    new ManualRuntime(),
    "writer",
    {
      load: async () => null,
      write: async () => {
        writes += 1;
        return draftWrite.promise;
      },
      remove: async () => "removed",
    },
  );
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
  });
  void session.perform({ type: "checkpoint-cloud" });
  await waitUntil(() => writes === 1);
  expect(cloud.saves).toHaveLength(0);

  draftWrite.resolve("written");
  await waitUntil(() => cloud.saves.length === 1);
});

test("uses jittered exponential retry delays capped at thirty seconds", async () => {
  const runtime = new ManualRuntime();
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, runtime);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
  });
  void session.perform({ type: "checkpoint-cloud" });
  const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
  for (const [index, delay] of delays.entries()) {
    await waitUntil(() => cloud.saves.length === index + 1);
    cloud.respond(index, { kind: "transient", reason: "server" });
    await waitForSnapshot(session, (snapshot) => snapshot.cloud.state === "retrying");
    runtime.advance(delay - 1);
    await Promise.resolve();
    expect(cloud.saves).toHaveLength(index + 1);
    runtime.advance(1);
  }
  await waitUntil(() => cloud.saves.length === delays.length + 1);
});

test("autosaves the latest document after a quiet debounce", async () => {
  const runtime = new ManualRuntime();
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, runtime);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
  });
  runtime.advance(1_000);
  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/b.mp4" },
  });
  runtime.advance(1_499);
  await Promise.resolve();
  expect(cloud.saves).toHaveLength(0);
  runtime.advance(1);
  await waitUntil(() => cloud.saves.length === 1);
  expect(cloud.saves[0]?.document.brollUrl).toBe(
    "https://cdn.example.com/b.mp4",
  );
});

test("forces a cloud checkpoint after five seconds of continuous edits", async () => {
  const runtime = new ManualRuntime();
  const cloud = new ControlledCloud(3, makeDocument());
  const session = await makeSession(cloud, runtime);
  for (const suffix of ["a", "b", "c", "d", "e"]) {
    session.dispatch({
      type: "document.edit",
      action: {
        type: "setBrollUrl",
        brollUrl: `https://cdn.example.com/${suffix}.mp4`,
      },
    });
    if (suffix !== "e") runtime.advance(1_000);
  }
  runtime.advance(999);
  await Promise.resolve();
  expect(cloud.saves).toHaveLength(0);
  runtime.advance(2);
  await waitUntil(() => cloud.saves.length === 1);
  expect(cloud.saves[0]?.document.brollUrl).toBe(
    "https://cdn.example.com/e.mp4",
  );
});
