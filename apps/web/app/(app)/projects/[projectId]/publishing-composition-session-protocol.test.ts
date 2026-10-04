import { expect, test } from "bun:test";
import type {
  BulkSocialScheduleOutcome,
  BulkSocialScheduleRequest,
  ClipExportSnapshot,
  ClipSnapshot,
  SocialAccountSnapshot,
} from "@narriflow/validators";
import {
  createPublishingCompositionSession,
  type PublishingCompositionStorage,
} from "./publishing-composition-session";
import { PublishingRequestError } from "./publishing-draft";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { actorId: id(1), workspaceId: id(2), projectId: id(3) };
const clips = [4, 5].map(
  (n) =>
    ({
      id: id(n),
      projectId: scope.projectId,
      editorRevision: 1,
      title: `Clip ${n}`,
      durationSec: 30,
    }) as ClipSnapshot,
);
const accounts: SocialAccountSnapshot[] = [
  {
    id: id(6),
    platform: "youtube_shorts",
    providerAccountId: "channel",
    displayName: "Channel",
    handle: null,
    avatarUrl: null,
    status: "active",
    scopes: [],
    expiresAt: null,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  },
];
const exports: ClipExportSnapshot[] = clips.map((clip, index) => ({
  id: id(10 + index),
  projectId: scope.projectId,
  clipId: clip.id,
  clipTitle: clip.title!,
  projectTitle: "Project",
  editorRevision: 1,
  currentEditorRevision: 1,
  isOlderVersion: false,
  resolution: "1080p",
  watermark: false,
  status: "ready",
  progress: 100,
  errorCode: null,
  createdAt: "2026-10-04T00:00:00.000Z",
  completedAt: null,
  variants: [
    {
      id: id(20 + index),
      aspectRatio: "9:16",
      resolution: "1080p",
      watermark: false,
      status: "completed",
      sizeBytes: 42_000,
      durationSec: 30,
      errorCode: null,
      hasAsset: true,
      completedAt: null,
    },
  ],
}));
const facts = {
  clips,
  accounts,
  workspaceTimezone: "Asia/Karachi",
  facebookPublishingEnabled: false,
};
const submissionFacts = { exports, options: {} };
const draftKey = (clipId = clips[0]!.id) => `${clipId}:${accounts[0]!.id}`;
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function harness(
  storage: PublishingCompositionStorage = memoryStorage(),
  currentScope = scope,
) {
  let allocations = 0;
  const session = createPublishingCompositionSession({
    scope: currentScope,
    storage,
    createId: () => id(200 + ++allocations),
    now: () => new Date("2026-10-04T10:00:00.000Z"),
  });
  return { session, allocations: () => allocations };
}
function prepare(
  session: ReturnType<typeof harness>["session"],
  selection = [clips[0]!.id],
) {
  session.open(selection, facts);
  for (const clipId of selection)
    session.updateDraft(draftKey(clipId), { caption: `Description ${clipId}` });
}
function completed(
  payload: BulkSocialScheduleRequest,
): BulkSocialScheduleOutcome {
  return {
    status: "completed",
    items: payload.items.map((item, index) => ({
      clipId: item.clipId,
      accountId: item.accountId,
      status: "succeeded",
      socialPostId: id(100 + index),
      errorCode: null,
      retryable: false,
    })),
    counts: { succeeded: payload.items.length, failed: 0, ineligible: 0 },
  };
}
function pending(storage: ReturnType<typeof memoryStorage>) {
  const record = [...storage.values.entries()].find(([key]) =>
    key.endsWith(":submission"),
  );
  return record ? (JSON.parse(record[1]) as BulkSocialScheduleRequest) : null;
}

test("response loss restores the exact request despite changed composition facts", async () => {
  const storage = memoryStorage();
  const first = harness(storage);
  prepare(first.session);
  const sent: BulkSocialScheduleRequest[] = [];
  await first.session.submit(submissionFacts, async (payload) => {
    sent.push(payload);
    expect(pending(storage)).toEqual(payload);
    throw new Error("response lost after commit");
  });
  const restored = harness(storage);
  restored.session.open([clips[1]!.id], {
    ...facts,
    clips: clips.map((clip) => ({ ...clip, editorRevision: 8 })),
    accounts: accounts.map((account) => ({ ...account, status: "expired" })),
    workspaceTimezone: "UTC",
  });
  await restored.session.submit(
    { exports: [], options: {} },
    async (payload) => {
      sent.push(payload);
      return completed(payload);
    },
  );
  expect(sent[1]).toEqual(sent[0]);
  expect(restored.allocations()).toBe(0);
  expect(restored.session.getSnapshot().pending).toBeNull();
  expect(pending(storage)).toBeNull();
});

test.each([408, 409, 429, 500, 503])(
  "HTTP %s retains the exact request for confirmation",
  async (status) => {
    const storage = memoryStorage();
    const { session } = harness(storage);
    prepare(session);
    await session.submit(submissionFacts, async () => {
      throw new PublishingRequestError("Unconfirmed", status);
    });
    const original = pending(storage)!;
    await session.submit(submissionFacts, async (payload) => {
      expect(payload).toEqual(original);
      return completed(payload);
    });
    expect(session.getSnapshot().pending).toBeNull();
  },
);

test.each([400, 401, 403, 404, 422])(
  "HTTP %s forgets rejected identity for an intentional corrected request",
  async (status) => {
    const storage = memoryStorage();
    const { session } = harness(storage);
    prepare(session);
    let rejectedKey = "";
    await session.submit(submissionFacts, async (payload) => {
      rejectedKey = payload.idempotencyKey;
      throw new PublishingRequestError("Rejected", status);
    });
    expect(pending(storage)).toBeNull();
    expect(session.getSnapshot().pending).toBeNull();
    session.updateDraft(draftKey(), { caption: "Corrected description" });
    await session.submit(submissionFacts, async (payload) => {
      expect(payload.idempotencyKey).not.toBe(rejectedKey);
      expect(payload.items[0]!.copy.caption).toBe("Corrected description");
      return completed(payload);
    });
  },
);

test.each([
  "bad counts",
  "missing accepted identity",
  "missing pair",
  "unexpected pair",
])("a %s outcome cannot erase pending identity", async (failure) => {
  const storage = memoryStorage();
  const { session } = harness(storage);
  prepare(
    session,
    clips.map((clip) => clip.id),
  );
  await session.submit(submissionFacts, async (payload) => {
    const result = completed(payload);
    if (failure === "bad counts")
      return { ...result, counts: { succeeded: 1, failed: 0, ineligible: 0 } };
    if (failure === "missing accepted identity")
      return {
        ...result,
        items: result.items.map((item) => ({ ...item, socialPostId: null })),
      };
    if (failure === "unexpected pair")
      return {
        ...result,
        items: result.items.map((item, index) =>
          index === 0 ? { ...item, accountId: id(99) } : item,
        ),
      };
    return {
      ...result,
      items: result.items.slice(0, 1),
      counts: { succeeded: 1, failed: 0, ineligible: 0 },
    };
  });
  const original = pending(storage)!;
  expect(original).not.toBeNull();
  expect(session.getSnapshot().result).toBeNull();
  expect(session.getSnapshot().error).toContain("incomplete");
  await session.submit(submissionFacts, async (payload) => {
    expect(payload).toEqual(original);
    return completed(payload);
  });
});

test("running outcomes retain the frozen request until a terminal result settles it", async () => {
  const storage = memoryStorage();
  const { session } = harness(storage);
  prepare(session);
  const draft = session.getSnapshot().drafts[draftKey()]!;
  await session.submit(submissionFacts, async (payload) => ({
    status: "running",
    items: payload.items.map((item) => ({
      clipId: item.clipId,
      accountId: item.accountId,
      status: "processing",
      socialPostId: null,
      errorCode: null,
      retryable: false,
    })),
    counts: { succeeded: 0, failed: 0, ineligible: 0 },
  }));
  const original = pending(storage)!;
  session.updateDraft(draftKey(), { caption: "Changed while waiting" });
  expect(session.getSnapshot().drafts[draftKey()]).toEqual(draft);
  await session.submit(submissionFacts, async (payload) => {
    expect(payload).toEqual(original);
    return completed(payload);
  });
  expect(session.getSnapshot().pending).toBeNull();
});

for (const disposition of ["running", "response lost", "accepted"] as const) {
  test(`late forced generation cannot change the draft after submission is ${disposition}`, async () => {
    const storage = memoryStorage();
    const { session } = harness(storage);
    prepare(session);
    const frozenDraft = structuredClone(
      session.getSnapshot().drafts[draftKey()]!,
    );
    let resolveGeneration!: (response: unknown) => void;
    const generation = session.generate(
      { clipId: clips[0]!.id, force: true },
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    await session.submit(submissionFacts, async (payload) => {
      expect(payload.items[0]!.copy.caption).toBe(frozenDraft.caption);
      if (disposition === "response lost")
        throw new Error("response lost after admission");
      if (disposition === "accepted") return completed(payload);
      return {
        status: "running",
        items: payload.items.map((item) => ({
          clipId: item.clipId,
          accountId: item.accountId,
          status: "processing",
          socialPostId: null,
          errorCode: null,
          retryable: false,
        })),
        counts: { succeeded: 0, failed: 0, ineligible: 0 },
      };
    });
    const request = pending(storage);
    resolveGeneration({
      variants: [
        {
          id: id(900),
          platform: "youtube_shorts",
          caption: "Late generated description",
          title: "Late generated title",
          hashtags: ["#late"],
        },
      ],
    });
    await generation;
    expect(session.getSnapshot().drafts[draftKey()]).toEqual(frozenDraft);
    expect(pending(storage)).toEqual(request);
    if (disposition === "accepted") {
      expect(session.getSnapshot().pending).toBeNull();
      expect(session.getSnapshot().result!.items[0]!.status).toBe("succeeded");
    } else {
      expect(session.getSnapshot().pending).toEqual(request);
      expect(request).not.toBeNull();
    }
  });
}

test("partial corrections preserve accepted pairs and submit only the corrected pair", async () => {
  const storage = memoryStorage();
  const { session } = harness(storage);
  prepare(
    session,
    clips.map((clip) => clip.id),
  );
  let firstKey = "";
  await session.submit(submissionFacts, async (payload) => {
    firstKey = payload.idempotencyKey;
    const result = completed(payload);
    return {
      ...result,
      status: "partial",
      items: result.items.map((item, index) =>
        index === 1
          ? {
              ...item,
              status: "ineligible",
              socialPostId: null,
              errorCode: "review_approval_required",
            }
          : item,
      ),
      counts: { succeeded: 1, failed: 0, ineligible: 1 },
    };
  });
  const accepted = session.getSnapshot().result!.items[0]!;
  session.updateDraft(draftKey(clips[0]!.id), {
    caption: "Cannot edit accepted copy",
  });
  session.updateDraft(draftKey(clips[1]!.id), {
    caption: "Corrected second clip",
  });
  const corrected = await session.submit(submissionFacts, async (payload) => {
    expect(payload.idempotencyKey).not.toBe(firstKey);
    expect(payload.items.map((item) => item.clipId)).toEqual([clips[1]!.id]);
    expect(payload.items[0]!.copy.caption).toBe("Corrected second clip");
    return completed(payload);
  });
  expect(corrected!.counts).toEqual({ succeeded: 2, failed: 0, ineligible: 0 });
  expect(corrected!.items[0]).toEqual(accepted);
  expect(
    session.getSnapshot().drafts[draftKey(clips[0]!.id)]!.caption,
  ).not.toBe("Cannot edit accepted copy");
});

test("pending storage failure prevents an unsaved request from being sent", async () => {
  const backing = memoryStorage();
  let fail = true;
  const { session } = harness({
    ...backing,
    setItem(key, value) {
      if (fail && key.endsWith(":submission")) throw new Error("storage full");
      backing.setItem(key, value);
    },
  });
  prepare(session);
  let calls = 0;
  await session.submit(submissionFacts, async (payload) => {
    calls += 1;
    return completed(payload);
  });
  expect(calls).toBe(0);
  expect(session.getSnapshot().pending).toBeNull();
  fail = false;
  await session.submit(submissionFacts, async (payload) => {
    calls += 1;
    return completed(payload);
  });
  expect(calls).toBe(1);
});

for (const failedWrite of ["outcome", "pending removal"] as const) {
  test(`${failedWrite} storage failure retains accepted identity through restore`, async () => {
    const backing = memoryStorage();
    const original = harness({
      ...backing,
      setItem(key, value) {
        if (failedWrite === "outcome" && key.endsWith(":outcome"))
          throw new Error("outcome storage failed");
        backing.setItem(key, value);
      },
      removeItem(key) {
        if (failedWrite === "pending removal" && key.endsWith(":submission"))
          throw new Error("pending removal failed");
        backing.removeItem(key);
      },
    });
    prepare(original.session);
    await original.session.submit(submissionFacts, async (payload) =>
      completed(payload),
    );
    const acceptedRequest = pending(backing)!;
    expect(acceptedRequest).not.toBeNull();
    const restored = harness(backing);
    restored.session.open([clips[0]!.id], facts);
    await restored.session.submit(submissionFacts, async (payload) => {
      expect(payload).toEqual(acceptedRequest);
      return completed(payload);
    });
    expect(restored.allocations()).toBe(0);
    expect(pending(backing)).toBeNull();
  });
}

test("unavailable pending reads cannot replace an unknown prior submission", async () => {
  const backing = memoryStorage();
  const original = harness(backing);
  prepare(original.session);
  await original.session.submit(submissionFacts, async () => {
    throw new Error("response lost");
  });
  const acceptedRequest = pending(backing)!;
  let unavailable = true;
  const restored = harness({
    ...backing,
    getItem(key) {
      if (unavailable && key.endsWith(":submission"))
        throw new Error("pending reader unavailable");
      return backing.getItem(key);
    },
  });
  prepare(restored.session);
  let calls = 0;
  await restored.session.submit(submissionFacts, async (payload) => {
    calls += 1;
    return completed(payload);
  });
  expect(calls).toBe(0);
  expect(restored.allocations()).toBe(0);
  expect(pending(backing)).toEqual(acceptedRequest);
  unavailable = false;
  await restored.session.submit(submissionFacts, async (payload) => {
    expect(payload).toEqual(acceptedRequest);
    return completed(payload);
  });
  expect(restored.allocations()).toBe(0);
  expect(pending(backing)).toBeNull();
});

test("an unavailable saved outcome cannot reopen an already accepted pair", async () => {
  const backing = memoryStorage();
  const original = harness(backing);
  prepare(
    original.session,
    clips.map((clip) => clip.id),
  );
  await original.session.submit(submissionFacts, async (payload) => {
    const result = completed(payload);
    return {
      ...result,
      status: "partial",
      items: result.items.map((item, index) =>
        index === 1
          ? {
              ...item,
              status: "ineligible",
              socialPostId: null,
              errorCode: "review_approval_required",
            }
          : item,
      ),
      counts: { succeeded: 1, failed: 0, ineligible: 1 },
    };
  });
  const restored = harness({
    ...backing,
    getItem(key) {
      if (key.endsWith(":outcome"))
        throw new Error("outcome reader unavailable");
      return backing.getItem(key);
    },
  });
  prepare(
    restored.session,
    clips.map((clip) => clip.id),
  );
  let calls = 0;
  await restored.session.submit(submissionFacts, async (payload) => {
    calls += 1;
    return completed(payload);
  });
  expect(calls).toBe(0);
  expect(restored.allocations()).toBe(0);
  const readable = harness(backing);
  readable.session.open(
    clips.map((clip) => clip.id),
    facts,
  );
  readable.session.updateDraft(draftKey(clips[1]!.id), {
    caption: "Corrected second clip",
  });
  await readable.session.submit(submissionFacts, async (payload) => {
    expect(payload.items.map((item) => item.clipId)).toEqual([clips[1]!.id]);
    return completed(payload);
  });
  expect(readable.session.getSnapshot().result!.counts.succeeded).toBe(2);
});

test("corrupt draft and copy caches cannot hide a valid pending request", async () => {
  const storage = memoryStorage();
  const original = harness(storage);
  prepare(original.session);
  await original.session.submit(submissionFacts, async () => {
    throw new Error("response lost");
  });
  const acceptedRequest = pending(storage)!;
  const recordKey = [...storage.values.keys()].find(
    (key) => !key.endsWith(":submission"),
  )!;
  storage.setItem(recordKey, "{");
  storage.setItem(`${recordKey}:copy`, JSON.stringify({ malformed: 1 }));
  storage.setItem(
    `${recordKey}:generations`,
    JSON.stringify({ malformed: { key: "unknown", signature: 42 } }),
  );
  const restored = harness(storage);
  restored.session.open([clips[0]!.id], facts);
  await restored.session.submit(
    { exports: [], options: {} },
    async (payload) => {
      expect(payload).toEqual(acceptedRequest);
      return completed(payload);
    },
  );
  expect(restored.allocations()).toBe(0);
  expect(restored.session.getSnapshot().pending).toBeNull();
});

test("concurrent callers share one submission and durable identity", async () => {
  const storage = memoryStorage();
  const { session, allocations } = harness(storage);
  prepare(session);
  let finish!: (outcome: BulkSocialScheduleOutcome) => void;
  let sent!: BulkSocialScheduleRequest;
  let calls = 0;
  const send = async (payload: BulkSocialScheduleRequest) => {
    calls += 1;
    sent = payload;
    expect(pending(storage)).toEqual(payload);
    return new Promise<BulkSocialScheduleOutcome>((resolve) => {
      finish = resolve;
    });
  };
  const first = session.submit(submissionFacts, send);
  const second = session.submit(submissionFacts, send);
  expect(first).toBe(second);
  expect(session.getSnapshot().busy).toBe(true);
  finish(completed(sent));
  await Promise.all([first, second]);
  expect(calls).toBe(1);
  expect(allocations()).toBe(1);
  expect(session.getSnapshot().busy).toBe(false);
});

test("actor, Workspace, and Project scopes cannot restore another draft or pending identity", async () => {
  const storage = memoryStorage();
  const original = harness(storage);
  prepare(original.session);
  await original.session.submit(submissionFacts, async () => {
    throw new Error("response lost");
  });
  const acceptedRequest = pending(storage)!;
  for (const changed of [
    { ...scope, actorId: id(90) },
    { ...scope, workspaceId: id(91) },
    { ...scope, projectId: id(92) },
  ]) {
    const isolated = harness(storage, changed);
    isolated.session.open([clips[0]!.id], facts);
    expect(isolated.session.getSnapshot().pending).toBeNull();
    expect(isolated.session.getSnapshot().drafts[draftKey()]!.caption).toBe("");
  }
  expect(pending(storage)).toEqual(acceptedRequest);
});
