import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { PrismaPg } from "@prisma/adapter-pg";
import { databasePoolConfig } from "./client";

/** A PostgreSQL peer that either never authenticates or authenticates and then
 * stops answering queries. No real database or credential is involved. */
async function silentDatabase(authenticate: boolean) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let startup = Buffer.alloc(0);
    let authenticated = false;
    socket.on("data", (bytes) => {
      if (!authenticate || authenticated) return;
      startup = Buffer.concat([startup, bytes]);
      if (startup.length < 4 || startup.length < startup.readInt32BE(0)) return;
      authenticated = true;
      socket.write(Buffer.from([
        82, 0, 0, 0, 8, 0, 0, 0, 0, // AuthenticationOk
        90, 0, 0, 0, 5, 73, // ReadyForQuery, idle
      ]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test peer address");
  return {
    url: `postgresql://test:test@127.0.0.1:${address.port}/test?sslmode=disable`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

for (const authenticate of [false, true]) {
  test(authenticate ? "a silent PostgreSQL query expires" : "a silent PostgreSQL connection expires", async () => {
    const peer = await silentDatabase(authenticate);
    const adapter = await new PrismaPg({
      connectionString: peer.url,
      ...databasePoolConfig({
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: authenticate ? "5000" : "80",
        DATABASE_POOL_QUERY_TIMEOUT_MS: authenticate ? "80" : "5000",
      }),
    }).connect();
    const startedAt = performance.now();
    try {
      await expect(adapter.queryRaw({ sql: "SELECT 1", args: [], argTypes: [] })).rejects.toThrow();
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await peer.close();
      await adapter.dispose();
    }
  });
}
