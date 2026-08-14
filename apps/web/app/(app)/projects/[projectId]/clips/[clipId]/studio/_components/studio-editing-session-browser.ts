import { editorDocumentSchema } from "@narriflow/validators";
import {
  claimEditorLease,
  editorDraftKey,
  editorLeaseKey,
  loadEditorDraft,
  persistEditorDraft,
  releaseEditorLease,
  removeEditorDraft,
  renewEditorLease,
  EDITOR_LEASE_HEARTBEAT_MS,
} from "./local-editor-draft";
import type {
  StudioCoordinationParticipant,
  StudioDraftRecord,
  StudioSessionIdentity,
  StudioSessionDependencies,
} from "./studio-editing-session";

type CoordinationEvent =
  | { type: "takeover-request"; ownerId: string; requestId: string }
  | {
      type: "handoff-ready";
      ownerId: string;
      targetId: string;
      requestId: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseStudioCoordinationEvent(value: unknown): CoordinationEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (
    value.type === "takeover-request" &&
    typeof value.ownerId === "string" &&
    typeof value.requestId === "string"
  ) {
    return { type: value.type, ownerId: value.ownerId, requestId: value.requestId };
  }
  if (
    value.type === "handoff-ready" &&
    typeof value.ownerId === "string" &&
    typeof value.targetId === "string" &&
    typeof value.requestId === "string"
  ) {
    return {
      type: value.type,
      ownerId: value.ownerId,
      targetId: value.targetId,
      requestId: value.requestId,
    };
  }
  return null;
}

type StudioCoordinationAdapter = StudioSessionDependencies["coordination"];

class BrowserStudioCoordinationAdapter implements StudioCoordinationAdapter {
  private readonly ownerId = crypto.randomUUID();
  private readonly leaseKey: string;
  private readonly generationKey: string;
  private readonly signalKey: string;
  private readonly channelName: string;
  private participant: StudioCoordinationParticipant | null = null;
  private channel: BroadcastChannel | null = null;
  private releaseBrowserLock: (() => void) | null = null;
  private heartbeat: number | null = null;
  private coordinationMode: "web-locks" | "storage" | "degraded" = "degraded";
  private storageAvailable = false;
  private ownsWrites = false;
  private closed = false;
  private generation = 0;
  private handoffInFlight = false;
  private readonly handoffWaiters = new Map<string, () => void>();

  constructor(projectId: string, clipId: string) {
    this.leaseKey = editorLeaseKey(projectId, clipId);
    this.generationKey = `${this.leaseKey}:generation`;
    this.signalKey = `${this.leaseKey}:signal`;
    this.channelName = `narriflow:studio:${editorDraftKey(projectId, clipId)}`;
  }

  async start(participant: StudioCoordinationParticipant) {
    this.participant = participant;
    this.openEventTransports();
    if (navigator.locks) {
      try {
        this.coordinationMode = "web-locks";
        const generation = await this.acquireBrowserLock({ ifAvailable: true });
        if (generation !== null) return { kind: "writer" as const, generation };
        return { kind: "reader" as const, generation: this.readGeneration() };
      } catch {
        // Web Locks can exist while being denied by browser policy. The
        // local-storage lease below is the normalized compatibility path.
      }
    }
    if (this.storageAvailable) {
      this.coordinationMode = "storage";
      const claimed = claimEditorLease(
        localStorage,
        this.leaseKey,
        this.ownerId,
        Date.now(),
      );
      if (claimed) {
        this.ownsWrites = true;
        this.generation = this.nextGeneration();
      }
      this.heartbeat = window.setInterval(() => this.heartbeatLease(), EDITOR_LEASE_HEARTBEAT_MS);
      return claimed
        ? { kind: "writer" as const, generation: this.generation }
        : { kind: "reader" as const, generation: this.readGeneration() };
    }
    this.ownsWrites = true;
    this.coordinationMode = "degraded";
    this.generation = Math.max(1, Date.now());
    return { kind: "degraded" as const, generation: this.generation };
  }

  async takeOver(timeoutMs: number) {
    if (this.closed || !this.participant) return { kind: "failed" as const };
    const requestId = crypto.randomUUID();
    let timer = 0;
    const cooperative = new Promise<boolean>((resolve) => {
      this.handoffWaiters.set(requestId, () => resolve(true));
      timer = window.setTimeout(() => resolve(false), timeoutMs);
    });
    this.send({ type: "takeover-request", ownerId: this.ownerId, requestId });
    const handedOff = await cooperative;
    window.clearTimeout(timer);
    this.handoffWaiters.delete(requestId);

    if (navigator.locks && this.coordinationMode === "web-locks") {
      try {
        const generation = await this.acquireBrowserLock({ steal: true });
        if (generation !== null) {
          return { kind: "acquired" as const, generation, forced: !handedOff };
        }
      } catch {
        // Continue through the compatibility fallback.
      }
    }
    if (this.storageAvailable) {
      const claimed = claimEditorLease(
        localStorage,
        this.leaseKey,
        this.ownerId,
        Date.now(),
        true,
      );
      if (!claimed) return { kind: "failed" as const };
      this.ownsWrites = true;
      this.generation = this.nextGeneration();
      return {
        kind: "acquired" as const,
        generation: this.generation,
        forced: !handedOff,
      };
    }
    return { kind: "failed" as const };
  }

  relinquish(): void {
    this.releaseOwnership();
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.releaseOwnership();
    window.removeEventListener("storage", this.onStorage);
    this.channel?.removeEventListener("message", this.onChannelMessage);
    this.channel?.close();
    this.channel = null;
  }

  private openEventTransports(): void {
    try {
      const probe = `${this.signalKey}:probe`;
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      this.storageAvailable = true;
      window.addEventListener("storage", this.onStorage);
    } catch {
      this.storageAvailable = false;
    }
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(this.channelName);
      this.channel.addEventListener("message", this.onChannelMessage);
    }
  }

  private readonly onChannelMessage = (event: MessageEvent<unknown>) => {
    this.receive(event.data);
  };

  private readonly onStorage = (event: StorageEvent) => {
    if (event.key === this.signalKey && event.newValue) {
      try {
        const envelope = JSON.parse(event.newValue) as { event?: unknown };
        this.receive(envelope.event);
      } catch {
        // Invalid compatibility signals are ignored.
      }
      return;
    }
    if (event.key === this.leaseKey && event.newValue && this.ownsWrites) {
      try {
        const lease = JSON.parse(event.newValue) as { ownerId?: unknown };
        if (typeof lease.ownerId === "string" && lease.ownerId !== this.ownerId) {
          this.ownsWrites = false;
          this.participant?.onOwnershipLost();
        }
      } catch {
        // Lease validation/expiry is handled by the heartbeat path.
      }
    }
  };

  private receive(raw: unknown): void {
    const event = parseStudioCoordinationEvent(raw);
    if (!event || event.ownerId === this.ownerId) return;
    if (
      event.type === "handoff-ready" &&
      event.targetId === this.ownerId
    ) {
      this.handoffWaiters.get(event.requestId)?.();
      return;
    }
    if (event.type === "takeover-request" && this.ownsWrites) {
      void this.handoff(event.ownerId, event.requestId);
    }
  }

  private async handoff(targetId: string, requestId: string): Promise<void> {
    if (this.handoffInFlight) return;
    this.handoffInFlight = true;
    try {
      const outcome =
        (await this.participant?.onTakeoverRequested()) ?? "unavailable";
      if (outcome !== "checkpointed") return;
      this.releaseOwnership();
      this.participant?.onOwnershipLost();
      this.send({
        type: "handoff-ready",
        ownerId: this.ownerId,
        targetId,
        requestId,
      });
    } finally {
      this.handoffInFlight = false;
    }
  }

  private send(event: CoordinationEvent): void {
    this.channel?.postMessage(event);
    if (!this.storageAvailable) return;
    try {
      localStorage.setItem(
        this.signalKey,
        JSON.stringify({ nonce: crypto.randomUUID(), event }),
      );
    } catch {
      this.storageAvailable = false;
    }
  }

  private async acquireBrowserLock(
    options: LockOptions,
  ): Promise<number | null> {
    const acquired = new Promise<number | null>((resolve, reject) => {
      let lockWasAcquired = false;
      void navigator.locks
        .request(this.leaseKey, options, async (lock) => {
          if (!lock || this.closed) {
            resolve(null);
            return;
          }
          this.coordinationMode = "web-locks";
          this.ownsWrites = true;
          lockWasAcquired = true;
          this.generation = this.nextGeneration();
          let release!: () => void;
          const held = new Promise<void>((done) => {
            release = done;
          });
          this.releaseBrowserLock = release;
          resolve(this.generation);
          await held;
          this.releaseBrowserLock = null;
          this.ownsWrites = false;
        })
        .catch((error: unknown) => {
          if (!lockWasAcquired) {
            reject(error);
            return;
          }
          if (!this.ownsWrites) return;
          this.releaseBrowserLock = null;
          this.ownsWrites = false;
          this.participant?.onOwnershipLost();
        });
    });
    return acquired;
  }

  private heartbeatLease(): void {
    if (this.closed || !this.storageAvailable) return;
    if (!this.ownsWrites) return;
    const owned = renewEditorLease(
      localStorage,
      this.leaseKey,
      this.ownerId,
      Date.now(),
    );
    if (!owned) {
      this.ownsWrites = false;
      this.participant?.onOwnershipLost();
    }
  }

  private releaseOwnership(): void {
    this.releaseBrowserLock?.();
    this.releaseBrowserLock = null;
    if (
      this.storageAvailable &&
      this.ownsWrites &&
      this.coordinationMode === "storage"
    ) {
      releaseEditorLease(localStorage, this.leaseKey, this.ownerId);
    }
    this.ownsWrites = false;
  }

  private readGeneration(): number {
    if (!this.storageAvailable) return this.generation;
    try {
      const value = Number(localStorage.getItem(this.generationKey));
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
      return this.generation;
    }
  }

  private nextGeneration(): number {
    const next = this.storageAvailable
      ? this.readGeneration() + 1
      : Math.max(this.generation + 1, Date.now());
    if (this.storageAvailable) {
      try {
        localStorage.setItem(this.generationKey, String(next));
      } catch {
        this.storageAvailable = false;
      }
    }
    return next;
  }
}

export function createBrowserStudioSessionDependencies(
  input: StudioSessionIdentity,
): StudioSessionDependencies {
  const expectedDraftKey = editorDraftKey(input.projectId, input.clipId);
  const assertDraftKey = (key: string) => {
    if (key !== expectedDraftKey) {
      throw new Error("Device Draft key does not match this Studio session");
    }
  };
  return {
    drafts: {
      load: async (key) => {
        assertDraftKey(key);
        return (await loadEditorDraft(
          input.projectId,
          input.clipId,
        )) as StudioDraftRecord | null;
      },
      write: (record) => persistEditorDraft(record),
      remove: (key, generation) => {
        assertDraftKey(key);
        return removeEditorDraft(input.projectId, input.clipId, generation);
      },
    },
    coordination: new BrowserStudioCoordinationAdapter(input.projectId, input.clipId),
    cloud: {
      loadHead: async () => {
        const response = await fetch(
          `/api/projects/${input.projectId}/clips/${input.clipId}/editor`,
        );
        if (!response.ok) throw new Error(`Could not refresh editor head (${response.status})`);
        const value = (await response.json()) as { revision?: unknown; document?: unknown };
        if (typeof value.revision !== "number" || !Number.isInteger(value.revision)) {
          throw new Error("Editor head returned an invalid revision");
        }
        return {
          revision: value.revision,
          document: editorDocumentSchema.parse(value.document),
        };
      },
    },
    runtime: {
      now: () => Date.now(),
      createId: () => crypto.randomUUID(),
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (id) => window.clearTimeout(id),
    },
  };
}
