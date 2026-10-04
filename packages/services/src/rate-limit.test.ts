import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkRateLimit } from "./rate-limit";

describe("checkRateLimit (fail-open safety)", () => {
  let savedUrl: string | undefined;

  beforeAll(() => {
    savedUrl = process.env.UPSTASH_REDIS_URL;
    delete process.env.UPSTASH_REDIS_URL;
  });

  afterAll(() => {
    if (savedUrl === undefined) {
      delete process.env.UPSTASH_REDIS_URL;
    } else {
      process.env.UPSTASH_REDIS_URL = savedUrl;
    }
  });

  test("fails open (allowed=true) when Redis URL is unset", async () => {
    const result = await checkRateLimit("gen:user-1", 20, 60);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(20);
    expect(result.remaining).toBe(20);
  });

  test("stays open across repeated calls beyond the limit", async () => {
    for (let i = 0; i < 50; i += 1) {
      const result = await checkRateLimit("gen:user-2", 5, 60);
      expect(result.allowed).toBe(true);
    }
  });

  test("returns the configured limit shape", async () => {
    const result = await checkRateLimit("presign:user-3", 60, 60);
    expect(result).toEqual({ allowed: true, remaining: 60, limit: 60, availability: "unavailable" });
  });

  test("fails open for a malformed Redis credential URL", async () => {
    process.env.UPSTASH_REDIS_URL = "redis://user:secret@[invalid";
    try {
      await expect(checkRateLimit("gen:user-4", 20, 60)).resolves.toEqual({
        allowed: true,
        remaining: 20,
        limit: 20,
        availability: "unavailable",
      });
    } finally {
      delete process.env.UPSTASH_REDIS_URL;
    }
  });

  test("concurrent cold-start requests await Redis readiness and enforce the limit", async () => {
    let count = 0;
    const server = Bun.listen<{ buffer: string }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) { socket.data = { buffer: "" }; },
        data(socket, bytes) {
          socket.data.buffer += new TextDecoder().decode(bytes);
          while (true) {
            const request = readRedisCommand(socket.data.buffer);
            if (!request) return;
            socket.data.buffer = socket.data.buffer.slice(request.length);
            const command = request.arguments[0]?.toLowerCase();
            if (command === "info") {
              const info = "redis_version:7.2.0\r\nloading:0\r\nrole:master\r\n";
              socket.write(`$${info.length}\r\n${info}\r\n`);
            } else if (command === "incr") {
              socket.write(`:${++count}\r\n`);
            } else if (command === "expire") {
              socket.write(":1\r\n");
            } else {
              socket.write("+OK\r\n");
            }
          }
        },
      },
    });
    process.env.UPSTASH_REDIS_URL = `redis://127.0.0.1:${server.port}`;
    try {
      const results = await Promise.all(Array.from({ length: 4 }, () => checkRateLimit("cold-start", 2, 60)));
      expect(results.map(result => result.availability)).toEqual(Array(4).fill("available"));
      expect(results.filter(result => result.allowed)).toHaveLength(2);
      expect(results.map(result => result.remaining)).toEqual([1, 0, 0, 0]);
      expect(count).toBe(4);
    } finally {
      delete process.env.UPSTASH_REDIS_URL;
      server.stop(true);
    }
  });
});

/** A minimal RESP server exercises the real ioredis connection handshake. */
function readRedisCommand(input: string): { arguments: string[]; length: number } | null {
  const headerEnd = input.indexOf("\r\n");
  if (headerEnd < 0) return null;
  const count = Number(input.slice(1, headerEnd));
  let offset = headerEnd + 2;
  const arguments_: string[] = [];
  for (let index = 0; index < count; index++) {
    const lengthEnd = input.indexOf("\r\n", offset);
    if (lengthEnd < 0) return null;
    const length = Number(input.slice(offset + 1, lengthEnd));
    const start = lengthEnd + 2;
    if (input.length < start + length + 2) return null;
    arguments_.push(input.slice(start, start + length));
    offset = start + length + 2;
  }
  return { arguments: arguments_, length: offset };
}
