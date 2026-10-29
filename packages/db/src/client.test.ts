import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PrismaNeon } from "@prisma/adapter-neon";
import { DATABASE_POOL_DEFAULTS, databasePoolConfig } from "./client";

/** A websocket that never answers: the shape of a Neon connection that died
 * without a clean close. Tests open, close or ignore it by hand. */
class SilentWebSocket {
  static instances: SilentWebSocket[] = [];
  binaryType = "blob";
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly url: string) {
    SilentWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send() {}
  /** Like a real WebSocket, closing one that is still connecting reports
   * `close` — this is how the pool's timeout tears a dead socket down. */
  close() {
    queueMicrotask(() => this.fire("close"));
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({});
  }
}

const select = { sql: "select 1", args: [], argTypes: [] };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
  SilentWebSocket.instances = [];
  globalThis.WebSocket = SilentWebSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.WebSocket = realWebSocket;
});

async function adapterWith(config: Record<string, number>) {
  const factory = new PrismaNeon({
    connectionString: "postgresql://user:pass@fake.neon.tech/db",
    ...config,
  });
  return factory.connect();
}

async function settle(promise: Promise<unknown>) {
  const startedAt = Date.now();
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  return { error: error as Error | null, elapsedMs: Date.now() - startedAt };
}

describe("database pool config", () => {
  test("a process with no pool environment gets bounded connect, idle and query times", () => {
    expect(databasePoolConfig({})).toEqual(DATABASE_POOL_DEFAULTS);
    expect(DATABASE_POOL_DEFAULTS.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(DATABASE_POOL_DEFAULTS.query_timeout).toBeGreaterThan(0);
  });

  test("environment values override the defaults and bad values are ignored", () => {
    expect(
      databasePoolConfig({
        DATABASE_POOL_MAX: "4",
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: "2500",
        DATABASE_POOL_QUERY_TIMEOUT_MS: "9000",
        DATABASE_POOL_IDLE_TIMEOUT_MS: "-1",
      }),
    ).toEqual({
      max: 4,
      idleTimeoutMillis: DATABASE_POOL_DEFAULTS.idleTimeoutMillis,
      connectionTimeoutMillis: 2500,
      query_timeout: 9000,
    });
  });
});

describe("a dead Neon connection rejects instead of hanging", () => {
  test("control: the bare driver defaults leave that same query pending forever", async () => {
    const adapter = await adapterWith({});
    const outcome = await Promise.race([
      adapter.queryRaw(select).then(
        () => "settled",
        () => "settled",
      ),
      sleep(300).then(() => "still pending"),
    ]);
    expect(outcome).toBe("still pending");
  });

  test("a websocket that never opens fails the query at the connection timeout", async () => {
    const adapter = await adapterWith({ connectionTimeoutMillis: 80, query_timeout: 5_000 });
    const { error, elapsedMs } = await settle(adapter.queryRaw(select));
    expect(error).not.toBeNull();
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test("a connection that opens and then goes silent fails at the query timeout", async () => {
    const adapter = await adapterWith({ connectionTimeoutMillis: 5_000, query_timeout: 80 });
    const pending = settle(adapter.queryRaw(select));
    await sleep(10);
    SilentWebSocket.instances[0]?.fire("open");
    const { error, elapsedMs } = await pending;
    expect(error?.message).toContain("Query read timeout");
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test("a connection terminated mid-query rejects promptly", async () => {
    const adapter = await adapterWith({ connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
    const pending = settle(adapter.queryRaw(select));
    await sleep(10);
    const socket = SilentWebSocket.instances[0];
    socket?.fire("open");
    await sleep(10);
    socket?.fire("close");
    const { error, elapsedMs } = await pending;
    expect(error?.message).toContain("Connection terminated");
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
