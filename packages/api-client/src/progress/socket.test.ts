import { describe, expect, test } from "bun:test";
import { ApiScope } from "../core/scope";
import { createApiTransport } from "../core/transport";
import { ApiError } from "../core/error";
import { runProgressSocket } from "./socket";

const projectId = "50000000-0000-4000-8000-000000000001";
const event = (seq: number) => ({ type: "event", event: { event: "workflow.stage.updated", projectId, workflowRunId: "60000000-0000-4000-8000-000000000001", seq, stage: "clip_rendering", status: "running", progress: 10, errorCode: null, emittedAt: "2026-10-31T00:00:00.000Z" } });
class Socket extends EventTarget {
  readyState = 1;
  sent: string[] = [];
  constructor(frames: unknown[], keepOpen = false) {
    super();
    queueMicrotask(() => { for (const frame of frames) this.dispatchEvent(new MessageEvent("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) })); if (!keepOpen) this.close(); });
  }
  send(value: string) { this.sent.push(value); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
function harness(scripts: unknown[][], response?: () => Response) {
  const scope = new ApiScope(); scope.setUser("user"); scope.selectWorkspace("workspace");
  const tokens: string[] = [];
  const urls: string[] = [];
  const sockets: Socket[] = [];
  let minted = 0;
  const bound = createApiTransport({ baseUrl: "https://api.example.test", scope, getToken: async () => `bearer-${tokens.length + 1}`, fetch: async (_url, init) => {
    tokens.push(new Headers(init?.headers).get("Authorization") ?? "");
    minted += 1;
    return response?.() ?? Response.json({ ticket: `ticket-${minted}`, ticketExpiresAt: Date.now() + 30_000, subscriptionExpiresAt: Date.now() + 60_000 });
  } }).scoped({ userId: "user", workspaceId: "workspace" });
  return { scope, bound, tokens, urls, sockets, createSocket: (url: string) => { urls.push(url); const socket = new Socket(scripts.shift() ?? [], scripts.length === 0); sockets.push(socket); return socket as unknown as WebSocket; } };
}
const noSleep = async () => {};

describe("progress socket transport", () => {
  test("fresh Bearer tickets reconnect from applied cursor without putting the Bearer in a socket URL", async () => {
    const h = harness([[event(1), "{invalid", event(9)], [event(2)]]);
    const abort = new AbortController(); const applied: number[] = [];
    const end = await runProgressSocket({ transport: h.bound, projectId, signal: abort.signal, createSocket: h.createSocket, sleep: noSleep,
      onEvent: (message) => { if (message.kind === "event") { applied.push(message.event.seq); if (message.event.seq === 2) abort.abort(); } },
    });
    expect(end).toEqual({ reason: "aborted" }); expect(applied).toEqual([1, 2]); expect(h.tokens).toEqual(["Bearer bearer-1", "Bearer bearer-2"]);
    expect(h.urls.map((url) => new URL(url).searchParams.get("sinceSeq"))).toEqual(["0", "1"]);
    expect(h.urls[0]).toStartWith("wss://api.example.test/api/progress/"); expect(h.urls.join(" ")).not.toContain("bearer-");
  });
  test("an identity or Workspace change closes the socket even after ticket JSON tracking ends", async () => {
    const h = harness([[]]); const abort = new AbortController();
    const running = runProgressSocket({ transport: h.bound, projectId, signal: abort.signal, createSocket: h.createSocket, onEvent: () => {} });
    while (h.sockets.length === 0) await Bun.sleep(1);
    h.scope.selectWorkspace("other");
    expect(await running).toMatchObject({ reason: "fatal", error: { code: "scope_changed" } }); expect(h.sockets[0]?.readyState).toBe(3);
  });
  test("a gap never advances the applied cursor and a retention reset refreshes the snapshot", async () => {
    const h = harness([[event(3)], [{ type: "reset", cursor: 99 }, event(100)]]); const abort = new AbortController(); const seen: string[] = [];
    await runProgressSocket({ transport: h.bound, projectId, signal: abort.signal, createSocket: h.createSocket, sleep: noSleep,
      onEvent: (message) => { seen.push(message.kind); if (message.kind === "event") abort.abort(); },
    });
    expect(h.urls.map((url) => new URL(url).searchParams.get("sinceSeq"))).toEqual(["0", "0"]); expect(seen).toEqual(["reset", "event"]);
  });
  test("session expiry mints a fresh ticket, while membership revocation ends the connection", async () => {
    const h = harness([[{ type: "revoked", control: { error: "authentication_required" } }], [{ type: "revoked", control: { error: "workspace_membership_required" } }]]);
    const end = await runProgressSocket({ transport: h.bound, projectId, signal: new AbortController().signal, createSocket: h.createSocket, sleep: noSleep, onEvent: () => {} });
    expect(end).toMatchObject({ reason: "fatal", error: { code: "workspace_membership_required" } }); expect(h.tokens).toHaveLength(2); expect(h.sockets.every((socket) => socket.readyState === 3)).toBe(true);
  });
  test("ticket refusal and Retry-After stay authoritative", async () => {
    const h = harness([], () => Response.json({ error: "rate_limited", message: "Wait", requestId: "gate", retryAfterSeconds: 5 }, { status: 429, headers: { "Retry-After": "5" } }));
    const abort = new AbortController(); const waits: number[] = [];
    await runProgressSocket({ transport: h.bound, projectId, signal: abort.signal, onEvent: () => {}, sleep: async (ms) => { waits.push(ms); abort.abort(); } });
    expect(waits).toEqual([5_000]);
    const denied = harness([], () => Response.json({ error: "project_inaccessible", message: "Unavailable", requestId: "gate" }, { status: 403 }));
    expect(await runProgressSocket({ transport: denied.bound, projectId, signal: new AbortController().signal, onEvent: () => {} })).toMatchObject({ reason: "fatal", error: { status: 403 } });
  });
  test("an oversized frame reconnects without advancing its cursor", async () => {
    const h = harness([["x".repeat(65_537)], [event(1)]]); const abort = new AbortController(); let applied = 0;
    await runProgressSocket({ transport: h.bound, projectId, signal: abort.signal, createSocket: h.createSocket, sleep: noSleep, onEvent: () => { applied += 1; abort.abort(); } });
    expect(applied).toBe(1); expect(h.urls).toHaveLength(2);
  });
  test("a full 256-frame queue resumes after its last applied event", async () => {
    const h = harness([Array.from({ length: 257 }, (_, index) => event(index + 1)), [event(257)]]); const abort = new AbortController(); const applied: number[] = [];
    await runProgressSocket({ transport: h.bound, projectId, signal: abort.signal, createSocket: h.createSocket, sleep: noSleep, onEvent: (message) => { if (message.kind === "event") { applied.push(message.event.seq); if (message.event.seq === 257) abort.abort(); } } });
    expect(applied).toHaveLength(257); expect(h.urls.map((url) => new URL(url).searchParams.get("sinceSeq"))).toEqual(["0", "256"]);
  });
  test("a consumer failure rejects instead of silently losing its event", async () => {
    const h = harness([[event(1)]]); const failure = new ApiError({ code: "consumer", message: "consumer", status: 0 });
    await expect(runProgressSocket({ transport: h.bound, projectId, signal: new AbortController().signal, createSocket: h.createSocket, onEvent: () => { throw failure; } })).rejects.toBe(failure);
    expect(h.urls).toHaveLength(1); expect(h.sockets[0]?.readyState).toBe(3);
  });
});
