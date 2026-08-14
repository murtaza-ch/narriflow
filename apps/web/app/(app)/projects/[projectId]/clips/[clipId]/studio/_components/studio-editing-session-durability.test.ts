import { expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
} from "@narriflow/validators";
import {
  createStudioEditingSession,
  type StudioDraftRecord,
  type StudioSessionDependencies,
  type StudioSessionSnapshot,
} from "./studio-editing-session";

class MemoryDraftStore {
  record: StudioDraftRecord | null = null;

  load = async () => (this.record ? structuredClone(this.record) : null);

  write = async (record: StudioDraftRecord): Promise<"written" | "stale"> => {
    if (
      this.record &&
      this.record.ownershipGeneration > record.ownershipGeneration
    ) {
      return "stale";
    }
    this.record = structuredClone(record);
    return "written";
  };

  remove = async (
    _key: string,
    ownershipGeneration: number,
  ): Promise<"removed" | "stale"> => {
    if (
      this.record &&
      this.record.ownershipGeneration > ownershipGeneration
    ) {
      return "stale";
    }
    this.record = null;
    return "removed";
  };
}

class CooperativeCoordinationHub {
  private generation = 0;
  private owner: {
    participant: Parameters<StudioSessionDependencies["coordination"]["start"]>[0];
    endpoint: ReturnType<CooperativeCoordinationHub["createEndpoint"]>;
  } | null = null;

  createEndpoint() {
    let participant:
      | Parameters<StudioSessionDependencies["coordination"]["start"]>[0]
      | null = null;
    const endpoint: StudioSessionDependencies["coordination"] = {
      start: async (nextParticipant) => {
        participant = nextParticipant;
        if (!this.owner) {
          this.generation += 1;
          this.owner = { participant: nextParticipant, endpoint };
          return { kind: "writer", generation: this.generation };
        }
        return { kind: "reader", generation: this.generation };
      },
      takeOver: async () => {
        if (!participant) return { kind: "failed" };
        const previous = this.owner;
        if (previous && previous.endpoint !== endpoint) {
          await previous.participant.onTakeoverRequested();
          previous.participant.onOwnershipLost();
        }
        this.generation += 1;
        this.owner = { participant, endpoint };
        return {
          kind: "acquired",
          generation: this.generation,
          forced: false,
        };
      },
      close: () => {
        if (this.owner?.endpoint === endpoint) this.owner = null;
      },
    };
    return endpoint;
  }
}

class ForcedCoordinationHub {
  timeoutMs: number | null = null;
  private generation = 0;
  private owner:
    | Parameters<StudioSessionDependencies["coordination"]["start"]>[0]
    | null = null;

  createEndpoint() {
    let participant:
      | Parameters<StudioSessionDependencies["coordination"]["start"]>[0]
      | null = null;
    const endpoint: StudioSessionDependencies["coordination"] = {
      start: async (nextParticipant) => {
        participant = nextParticipant;
        if (!this.owner) {
          this.owner = nextParticipant;
          this.generation = 1;
          return { kind: "writer", generation: 1 };
        }
        return { kind: "reader", generation: this.generation };
      },
      takeOver: async (timeoutMs) => {
        if (!participant) return { kind: "failed" };
        this.timeoutMs = timeoutMs;
        const previous = this.owner;
        if (previous) {
          void previous.onTakeoverRequested();
          previous.onOwnershipLost();
        }
        this.generation += 1;
        this.owner = participant;
        return {
          kind: "acquired",
          generation: this.generation,
          forced: true,
        };
      },
      close: () => undefined,
    };
    return endpoint;
  }
}

function makeDocument(brollUrl: string | null = null): EditorDocument {
  return editorDocumentSchema.parse({
    clipStartSec: 10,
    clipEndSec: 40,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl,
    deletedRanges: [],
  });
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

test("defers browser adapter startup until the public session lifecycle starts", async () => {
  const cloud = makeDocument();
  let starts = 0;
  const session = createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 3,
      document: cloud,
      segments: [],
    },
    {
      drafts: {
        load: async () => null,
        write: async () => "written",
        remove: async () => "removed",
      },
      coordination: {
        start: async () => {
          starts += 1;
          return { kind: "writer", generation: 1 };
        },
        takeOver: async () => ({ kind: "acquired", generation: 2, forced: false }),
        close: () => undefined,
      },
      cloud: { loadHead: async () => ({ revision: 3, document: cloud }) },
      runtime: {
        now: () => 100,
        createId: () => "writer",
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    },
    { deferStart: true },
  );

  expect(starts).toBe(0);
  expect(session.getSnapshot().status).toBe("starting");
  expect(await session.perform({ type: "start" })).toEqual({ kind: "started" });
  await waitForSnapshot(session, (snapshot) => snapshot.status === "ready");
  expect(starts).toBe(1);
  expect(await session.perform({ type: "start" })).toEqual({
    kind: "unavailable",
    reason: "invalid-state",
  });
});

test("recovers a conflict-free Device Draft before accepting mutations", async () => {
  const cloud = makeDocument();
  const recovered = makeDocument("https://cdn.example.com/recovered.mp4");
  const draft: StudioDraftRecord = {
    formatVersion: 2,
    key: "project:clip",
    projectId: "project",
    clipId: "clip",
    baseRevision: 3,
    baseDocument: cloud,
    document: recovered,
    updatedAt: 100,
    writerId: "prior-writer",
    ownershipGeneration: 1,
  };
  const dependencies: StudioSessionDependencies = {
    drafts: {
      load: async () => draft,
      write: async () => "written",
      remove: async () => "removed",
    },
    coordination: {
      start: async () => ({ kind: "writer", generation: 2 }),
      takeOver: async () => ({ kind: "acquired", generation: 3, forced: false }),
      close: () => undefined,
    },
    cloud: {
      loadHead: async () => ({ revision: 3, document: cloud }),
    },
    runtime: {
      now: () => 200,
      createId: () => "writer-a",
      setTimeout: (callback) => {
        callback();
        return 1;
      },
      clearTimeout: () => undefined,
    },
  };

  const session = createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 3,
      document: cloud,
      segments: [],
    },
    dependencies,
  );

  expect(
    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/too-early.mp4" },
    }),
  ).toEqual({ accepted: false, reason: "starting" });

  const snapshot = await waitForSnapshot(session, (value) => value.status !== "starting");
  expect(snapshot.status).toBe("ready");
  expect(snapshot.document).toEqual(recovered);
  expect(snapshot.recovery).toEqual({ kind: "recovered", conflictPaths: [] });
  expect(snapshot.durability).toEqual({ device: "durable", protectsNavigation: false });
  expect(snapshot.ownership).toEqual({ kind: "writer", generation: 2 });
  expect(snapshot.capabilities.mutate).toBe(true);
});

test("lazily upgrades a readable version-one Device Draft after ownership is resolved", async () => {
  const cloud = makeDocument();
  const legacy: StudioDraftRecord = {
    formatVersion: 1,
    key: "project:clip",
    projectId: "project",
    clipId: "clip",
    baseRevision: 3,
    baseDocument: cloud,
    document: makeDocument("https://cdn.example.com/legacy.mp4"),
    updatedAt: 100,
    writerId: "legacy-writer",
    ownershipGeneration: 0,
  };
  let upgraded: StudioDraftRecord | null = null;
  const session = createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 3,
      document: cloud,
      segments: [],
    },
    {
      drafts: {
        load: async () => legacy,
        write: async (record) => {
          upgraded = record;
          return "written";
        },
        remove: async () => "removed",
      },
      coordination: {
        start: async () => ({ kind: "writer", generation: 4 }),
        takeOver: async () => ({ kind: "acquired", generation: 5, forced: false }),
        close: () => undefined,
      },
      cloud: { loadHead: async () => ({ revision: 3, document: cloud }) },
      runtime: {
        now: () => 300,
        createId: () => "writer-current",
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    },
  );

  await waitForSnapshot(session, (value) => value.status === "ready");
  expect(upgraded).toMatchObject({
    formatVersion: 2,
    ownershipGeneration: 4,
    writerId: "writer-current",
    document: { brollUrl: "https://cdn.example.com/legacy.mp4" },
  });
});

test("re-fences a recovered version-two draft before the new writer becomes editable", async () => {
  const cloud = makeDocument();
  const prior: StudioDraftRecord = {
    formatVersion: 2,
    key: "project:clip",
    projectId: "project",
    clipId: "clip",
    baseRevision: 3,
    baseDocument: cloud,
    document: makeDocument("https://cdn.example.com/prior.mp4"),
    updatedAt: 100,
    writerId: "writer-old",
    ownershipGeneration: 4,
  };
  let fenced: StudioDraftRecord | null = null;
  const session = createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 3,
      document: cloud,
      segments: [],
    },
    {
      drafts: {
        load: async () => prior,
        write: async (record) => {
          fenced = record;
          return "written";
        },
        remove: async () => "removed",
      },
      coordination: {
        start: async () => ({ kind: "writer", generation: 5 }),
        takeOver: async () => ({ kind: "acquired", generation: 6, forced: false }),
        close: () => undefined,
      },
      cloud: { loadHead: async () => ({ revision: 3, document: cloud }) },
      runtime: {
        now: () => 400,
        createId: () => "writer-new",
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    },
  );

  await waitForSnapshot(session, (value) => value.status === "ready");
  expect(fenced).toMatchObject({
    formatVersion: 2,
    ownershipGeneration: 5,
    writerId: "writer-new",
    document: { brollUrl: "https://cdn.example.com/prior.mp4" },
  });
});

test("keeps an overlapping Device Draft durable until the user chooses it", async () => {
  const base = makeDocument();
  const device = makeDocument("https://device.example.com/video.mp4");
  const cloud = makeDocument("https://cloud.example.com/video.mp4");
  const draft: StudioDraftRecord = {
    formatVersion: 2,
    key: "project:clip",
    projectId: "project",
    clipId: "clip",
    baseRevision: 3,
    baseDocument: base,
    document: device,
    updatedAt: 100,
    writerId: "prior-writer",
    ownershipGeneration: 1,
  };
  let removed = false;
  const session = createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 4,
      document: cloud,
      segments: [],
    },
    {
      drafts: {
        load: async () => draft,
        write: async () => "written",
        remove: async () => {
          removed = true;
          return "removed";
        },
      },
      coordination: {
        start: async () => ({ kind: "writer", generation: 2 }),
        takeOver: async () => ({ kind: "acquired", generation: 3, forced: false }),
        close: () => undefined,
      },
      cloud: { loadHead: async () => ({ revision: 4, document: cloud }) },
      runtime: {
        now: () => 200,
        createId: () => "writer-a",
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    },
  );

  const conflict = await waitForSnapshot(session, (value) => value.status === "conflict");
  expect(conflict.document).toEqual(cloud);
  expect(conflict.recovery).toEqual({ kind: "conflict", conflictPaths: ["brollUrl"] });
  expect(conflict.durability.device).toBe("durable");
  expect(
    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: null },
    }),
  ).toEqual({ accepted: false, reason: "conflict" });

  expect(await session.perform({ type: "resolve-conflict", choice: "device" })).toEqual({
    kind: "conflict-resolved",
    choice: "device",
  });
  expect(session.getSnapshot().document).toEqual(device);
  expect(session.getSnapshot().status).toBe("ready");
  expect(session.getSnapshot().history.canUndo).toBe(false);
  expect(removed).toBe(false);
});

test("keeps cloud editing available with navigation protection when Device Draft storage fails", async () => {
  const cloud = makeDocument();
  const session = createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 3,
      document: cloud,
      segments: [],
    },
    {
      drafts: {
        load: async () => {
          throw new Error("IndexedDB unavailable");
        },
        write: async () => {
          throw new Error("IndexedDB unavailable");
        },
        remove: async () => {
          throw new Error("IndexedDB unavailable");
        },
      },
      coordination: {
        start: async () => ({ kind: "writer", generation: 1 }),
        takeOver: async () => ({ kind: "acquired", generation: 2, forced: false }),
        close: () => undefined,
      },
      cloud: { loadHead: async () => ({ revision: 3, document: cloud }) },
      runtime: {
        now: () => 100,
        createId: () => "writer-a",
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    },
  );

  await waitForSnapshot(session, (value) => value.status === "ready");
  expect(session.getSnapshot().durability).toEqual({
    device: "degraded",
    protectsNavigation: true,
  });
  expect(
    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/cloud-only.mp4" },
    }),
  ).toEqual({ accepted: true });
  expect(session.getSnapshot().document.brollUrl).toBe(
    "https://cdn.example.com/cloud-only.mp4",
  );
});

test("marks an edit durable only after its fenced Device Draft write completes", async () => {
  const cloud = makeDocument();
  const timers: Array<() => void> = [];
  const writes: StudioDraftRecord[] = [];
  const session = createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 3,
      document: cloud,
      segments: [],
    },
    {
      drafts: {
        load: async () => null,
        write: async (record) => {
          writes.push(record);
          return "written";
        },
        remove: async () => "removed",
      },
      coordination: {
        start: async () => ({ kind: "writer", generation: 7 }),
        takeOver: async () => ({ kind: "acquired", generation: 8, forced: false }),
        close: () => undefined,
      },
      cloud: { loadHead: async () => ({ revision: 3, document: cloud }) },
      runtime: {
        now: () => 250,
        createId: () => "writer-a",
        setTimeout: (callback) => {
          timers.push(callback);
          return timers.length;
        },
        clearTimeout: () => undefined,
      },
    },
  );
  await waitForSnapshot(session, (value) => value.status === "ready");

  session.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/new.mp4" },
  });
  expect(session.getSnapshot().durability).toEqual({
    device: "pending",
    protectsNavigation: true,
  });
  expect(writes).toHaveLength(0);

  timers.shift()?.();
  await waitForSnapshot(
    session,
    (value) => value.durability.device === "durable",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    formatVersion: 2,
    key: "project:clip",
    baseRevision: 3,
    writerId: "writer-a",
    ownershipGeneration: 7,
    document: { brollUrl: "https://cdn.example.com/new.mp4" },
  });
  expect(session.getSnapshot().durability.protectsNavigation).toBe(false);
});

test("hands off the newest Device Draft before a second session becomes writable", async () => {
  const cloud = makeDocument();
  const drafts = new MemoryDraftStore();
  const coordination = new CooperativeCoordinationHub();
  let nextId = 0;
  const makeDependencies = (): StudioSessionDependencies => ({
    drafts,
    coordination: coordination.createEndpoint(),
    cloud: { loadHead: async () => ({ revision: 3, document: cloud }) },
    runtime: {
      now: () => 500,
      createId: () => `writer-${++nextId}`,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    },
  });
  const seed = {
    projectId: "project",
    clipId: "clip",
    cloudRevision: 3,
    document: cloud,
    segments: [],
  };
  const outgoing = createStudioEditingSession(seed, makeDependencies());
  await waitForSnapshot(outgoing, (value) => value.status === "ready");
  outgoing.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/outgoing.mp4" },
  });

  const incoming = createStudioEditingSession(seed, makeDependencies());
  await waitForSnapshot(incoming, (value) => value.ownership.kind === "reader");
  expect(
    incoming.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/rejected.mp4" },
    }),
  ).toEqual({ accepted: false, reason: "read-only" });

  expect(await incoming.perform({ type: "take-over" })).toMatchObject({
    kind: "ownership-acquired",
    forced: false,
  });
  expect(outgoing.getSnapshot().ownership.kind).toBe("reader");
  expect(drafts.record?.document.brollUrl).toBe(
    "https://cdn.example.com/outgoing.mp4",
  );
  expect(drafts.record?.ownershipGeneration).toBe(2);
  expect(incoming.getSnapshot().document.brollUrl).toBe(
    "https://cdn.example.com/outgoing.mp4",
  );
  expect(incoming.getSnapshot().ownership).toEqual({ kind: "writer", generation: 2 });
  expect(incoming.getSnapshot().capabilities.mutate).toBe(true);
});

test("fences a late outgoing checkpoint after a two-second forced takeover", async () => {
  const cloud = makeDocument();
  let stored: StudioDraftRecord | null = null;
  let finishStaleWrite: (() => void) | null = null;
  const drafts: StudioSessionDependencies["drafts"] = {
    load: async () => (stored ? structuredClone(stored) : null),
    write: async (record) => {
      if (record.ownershipGeneration === 1) {
        return new Promise((resolve) => {
          finishStaleWrite = () => resolve("stale");
        });
      }
      stored = structuredClone(record);
      return "written";
    },
    remove: async () => "removed",
  };
  const coordination = new ForcedCoordinationHub();
  let writerNumber = 0;
  const incomingTimers: Array<() => void> = [];
  const makeDependencies = (timers: Array<() => void>): StudioSessionDependencies => ({
    drafts,
    coordination: coordination.createEndpoint(),
    cloud: { loadHead: async () => ({ revision: 3, document: cloud }) },
    runtime: {
      now: () => 750,
      createId: () => `writer-${++writerNumber}`,
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => undefined,
    },
  });
  const seed = {
    projectId: "project",
    clipId: "clip",
    cloudRevision: 3,
    document: cloud,
    segments: [],
  };
  const outgoing = createStudioEditingSession(seed, makeDependencies([]));
  await waitForSnapshot(outgoing, (value) => value.status === "ready");
  outgoing.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/late.mp4" },
  });
  const incoming = createStudioEditingSession(seed, makeDependencies(incomingTimers));
  await waitForSnapshot(incoming, (value) => value.ownership.kind === "reader");

  expect(await incoming.perform({ type: "take-over" })).toMatchObject({
    kind: "ownership-acquired",
    forced: true,
  });
  expect(coordination.timeoutMs).toBe(2_000);
  incoming.dispatch({
    type: "document.edit",
    action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/current.mp4" },
  });
  incomingTimers.shift()?.();
  await waitForSnapshot(incoming, (value) => value.durability.device === "durable");
  expect(stored?.ownershipGeneration).toBe(2);

  if (!finishStaleWrite) throw new Error("expected delayed generation-one write");
  finishStaleWrite();
  await Promise.resolve();
  await Promise.resolve();
  expect(stored?.document.brollUrl).toBe("https://cdn.example.com/current.mp4");
  expect(outgoing.getSnapshot().ownership.kind).toBe("reader");
  expect(outgoing.getSnapshot().capabilities.mutate).toBe(false);
});

test("allows cloud-fenced editing while exposing degraded browser coordination", async () => {
  const cloud = makeDocument();
  const session = createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 3,
      document: cloud,
      segments: [],
    },
    {
      drafts: {
        load: async () => null,
        write: async () => "written",
        remove: async () => "removed",
      },
      coordination: {
        start: async () => ({ kind: "degraded", generation: 20 }),
        takeOver: async () => ({ kind: "failed" }),
        close: () => undefined,
      },
      cloud: { loadHead: async () => ({ revision: 3, document: cloud }) },
      runtime: {
        now: () => 1_000,
        createId: () => "degraded-writer",
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    },
  );

  const ready = await waitForSnapshot(session, (value) => value.status === "ready");
  expect(ready.ownership).toEqual({ kind: "degraded", generation: 20 });
  expect(ready.capabilities.mutate).toBe(true);
  expect(
    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/cloud-fenced.mp4" },
    }),
  ).toEqual({ accepted: true });
});

test("stops accepting mutations immediately when the coordination adapter reports ownership loss", async () => {
  const cloud = makeDocument();
  let participant:
    | Parameters<StudioSessionDependencies["coordination"]["start"]>[0]
    | null = null;
  const session = createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 3,
      document: cloud,
      segments: [],
    },
    {
      drafts: {
        load: async () => null,
        write: async () => "written",
        remove: async () => "removed",
      },
      coordination: {
        start: async (nextParticipant) => {
          participant = nextParticipant;
          return { kind: "writer", generation: 9 };
        },
        takeOver: async () => ({ kind: "failed" }),
        close: () => undefined,
      },
      cloud: { loadHead: async () => ({ revision: 3, document: cloud }) },
      runtime: {
        now: () => 1_000,
        createId: () => "writer-a",
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    },
  );
  await waitForSnapshot(session, (value) => value.status === "ready");

  if (!participant) throw new Error("expected coordination participant");
  participant.onOwnershipLost();
  expect(session.getSnapshot().ownership).toEqual({ kind: "reader", generation: 9 });
  expect(
    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/rejected.mp4" },
    }),
  ).toEqual({ accepted: false, reason: "read-only" });
});
