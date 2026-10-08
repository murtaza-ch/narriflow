import { describe, expect, test } from "bun:test";
import {
  assertPublicHttpUrl,
  assertPublicHttpUrlResolved,
  guardedFetch,
  readResponseBodyBounded,
  RemoteFetchError,
  type HostResolver,
  UnsafeUrlError,
} from "./url-guard";

const PUBLIC_ADDRESS = "93.184.216.34";
const publicResolver: HostResolver = async () => [
  { address: PUBLIC_ADDRESS, family: 4 },
];

describe("assertPublicHttpUrl", () => {
  test("accepts a public https feed URL", () => {
    const url = assertPublicHttpUrl("https://feeds.example.com/podcast.xml");
    expect(url.hostname).toBe("feeds.example.com");
  });

  test.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
  ])("rejects reserved literal %s", (value) => {
    expect(() => assertPublicHttpUrl(value)).toThrow(UnsafeUrlError);
  });

  test("rejects localhost", () => {
    expect(() => assertPublicHttpUrl("http://localhost:5432/")).toThrow(
      UnsafeUrlError,
    );
  });

  test("rejects embedded credentials", () => {
    try {
      assertPublicHttpUrl("https://user:secret@example.com/feed.xml");
      throw new Error("expected URL rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeUrlError);
      expect((error as UnsafeUrlError).details?.reason).toBe(
        "credentials_not_allowed",
      );
    }
  });

  test.each(["file:///etc/passwd", "ftp://example.com/file"])(
    "rejects unsupported scheme %s",
    (value) => {
      expect(() => assertPublicHttpUrl(value)).toThrow(UnsafeUrlError);
    },
  );

  test("rejects control characters before URL normalization", () => {
    expect(() =>
      assertPublicHttpUrl("https://example.com/feed\n.xml"),
    ).toThrow(UnsafeUrlError);
  });
});

describe("assertPublicHttpUrlResolved", () => {
  test("accepts a hostname when all resolved addresses are public", async () => {
    const url = await assertPublicHttpUrlResolved(
      "https://feeds.example.com/podcast.xml",
      publicResolver,
    );
    expect(url.hostname).toBe("feeds.example.com");
  });

  test.each(["127.0.0.1", "10.1.2.3", "169.254.169.254"])(
    "rejects a hostname resolving to %s",
    async (address) => {
      await expect(
        assertPublicHttpUrlResolved("https://feed.example/", async () => [
          { address, family: 4 },
        ]),
      ).rejects.toBeInstanceOf(UnsafeUrlError);
    },
  );

  test("rejects mixed public and private answers", async () => {
    await expect(
      assertPublicHttpUrlResolved("https://feed.example/", async () => [
        { address: PUBLIC_ADDRESS, family: 4 },
        { address: "10.0.0.2", family: 4 },
      ]),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe("guardedFetch", () => {
  test("accepts a public redirect and validates both hosts", async () => {
    const resolved: string[] = [];
    const fetched: string[] = [];
    const resolver: HostResolver = async (hostname) => {
      resolved.push(hostname);
      return [{ address: PUBLIC_ADDRESS, family: 4 }];
    };
    const transport = async (input: URL) => {
      const url = input.toString();
      fetched.push(url);
      if (fetched.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/media.mp3" },
        });
      }
      return new Response("media", { status: 200 });
    };

    const response = await guardedFetch("https://feed.example/episode", {
      transport,
      resolver,
    });

    expect(response.status).toBe(200);
    expect(resolved).toEqual(["feed.example", "cdn.example"]);
    expect(fetched).toHaveLength(2);
  });

  test("rejects a redirect to a private host before a second fetch", async () => {
    let fetchCount = 0;
    const transport = async () => {
      fetchCount += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://internal.example/secret" },
      });
    };

    await expect(
      guardedFetch("https://public.example/feed", {
        transport,
        resolver: async (hostname) => [
          {
            address:
              hostname === "internal.example"
                ? "127.0.0.1"
                : PUBLIC_ADDRESS,
            family: 4,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchCount).toBe(1);
  });

  test("rejects a redirect loop at the configured limit", async () => {
    let fetchCount = 0;
    try {
      await guardedFetch("https://loop.example/start", {
        transport: async () => {
          fetchCount += 1;
          return new Response(null, {
            status: 302,
            headers: { location: "/again" },
          });
        },
        maxRedirects: 2,
        resolver: publicResolver,
      });
      throw new Error("expected redirect rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteFetchError);
      expect((error as RemoteFetchError).code).toBe("remote_redirect_limit");
    }
    expect(fetchCount).toBe(3);
  });

  test("does not forward credentials to a different origin", async () => {
    const seenHeaders: Headers[] = [];
    await guardedFetch("https://feed.example/start", {
      transport: async (_url, init) => {
        seenHeaders.push(new Headers(init.headers));
        if (seenHeaders.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example/media" },
          });
        }
        return new Response(null, { status: 204 });
      },
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-request-id": "safe",
      },
      resolver: publicResolver,
    });

    expect(seenHeaders[0]?.get("authorization")).toBe("Bearer secret");
    expect(seenHeaders[1]?.has("authorization")).toBe(false);
    expect(seenHeaders[1]?.has("cookie")).toBe(false);
    expect(seenHeaders[1]?.get("x-request-id")).toBe("safe");
  });

  test("a pre-aborted request never resolves or fetches its URL", async () => {
    const shutdown = new AbortController();
    const reason = new Error("shutdown");
    shutdown.abort(reason);
    let calls = 0;
    await expect(guardedFetch("https://feed.example/media", {
      signal: shutdown.signal,
      resolver: async () => { calls++; return publicResolver("feed.example"); },
      transport: async () => { calls++; return new Response(); },
    })).rejects.toBe(reason);
    expect(calls).toBe(0);
  });

  test("external cancellation stops waiting for DNS without fetching", async () => {
    const shutdown = new AbortController();
    const reason = new Error("shutdown during DNS");
    let fetches = 0;
    let resolving!: () => void;
    const started = new Promise<void>((resolve) => { resolving = resolve; });
    const result = guardedFetch("https://feed.example/media", {
      signal: shutdown.signal,
      resolver: () => { resolving(); return new Promise(() => {}); },
      transport: async () => { fetches++; return new Response(); },
    }).catch((error) => error);
    await started;
    shutdown.abort(reason);
    expect(await result).toBe(reason);
    expect(fetches).toBe(0);
  });

  test("external cancellation preserves its reason during fetch", async () => {
    const shutdown = new AbortController();
    const reason = new Error("shutdown during fetch");
    let fetching!: () => void;
    const started = new Promise<void>((resolve) => { fetching = resolve; });
    const result = guardedFetch("https://feed.example/media", {
      signal: shutdown.signal,
      resolver: publicResolver,
      transport: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        fetching();
      }),
    }).catch((error) => error);
    await started;
    shutdown.abort(reason);
    expect(await result).toBe(reason);
  });

  test("external cancellation remains active during response streaming", async () => {
    const shutdown = new AbortController();
    const reason = new Error("shutdown during body");
    const response = await guardedFetch("https://feed.example/media", {
      signal: shutdown.signal,
      resolver: publicResolver,
      transport: async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
        },
      })),
    });
    const body = response.text().catch((error) => error);
    shutdown.abort(reason);
    expect(await body).toBe(reason);
  });

  test("keeps the timeout active while the response body is consumed", async () => {
    const response = await guardedFetch("https://feed.example/slow", {
      transport: async (_url, init) => {
        const signal = init.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                { once: true },
              );
            },
          }),
        );
      },
      resolver: publicResolver,
      timeoutMs: 10,
    });

    await expect(readResponseBodyBounded(response, 100)).rejects.toMatchObject({
      code: "remote_fetch_timeout",
    });
  });
});

describe("readResponseBodyBounded", () => {
  test("rejects an oversized declared body before reading it", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
      headers: { "content-length": "100" },
      },
    );
    await expect(readResponseBodyBounded(response, 10)).rejects.toMatchObject({
      code: "remote_response_too_large",
    });
    expect(cancelled).toBe(true);
  });

  test("rejects an oversized streamed body without a length header", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        },
      }),
    );
    await expect(readResponseBodyBounded(response, 5)).rejects.toMatchObject({
      code: "remote_response_too_large",
    });
  });

  test.each(["not-a-number", "2"])(
    "enforces the streamed limit with Content-Length %s",
    async (contentLength) => {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5, 6]));
            controller.close();
          },
        }),
        { headers: { "content-length": contentLength } },
      );

      await expect(readResponseBodyBounded(response, 5)).rejects.toMatchObject({
        code: "remote_response_too_large",
      });
    },
  );
});

describe("pinned connections", () => {
  test("connects to the validated answer when the resolver later rebinds to a private address", async () => {
    let lookups = 0;
    const rebinding: HostResolver = async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? PUBLIC_ADDRESS : "127.0.0.1", family: 4 }];
    };
    const connected: string[][] = [];
    const response = await guardedFetch("https://rebind.example/media", {
      resolver: rebinding,
      transport: async (_url, request) => {
        connected.push(request.addresses.map((address) => address.address));
        return new Response("ok");
      },
    });
    expect(await response.text()).toBe("ok");
    expect(lookups).toBe(1);
    expect(connected).toEqual([[PUBLIC_ADDRESS]]);
  });

  test("IP-literal hosts are checked without DNS and pinned to the literal", async () => {
    let lookups = 0;
    const connected: string[] = [];
    await guardedFetch("http://93.184.216.34/feed", {
      resolver: async () => { lookups += 1; return []; },
      transport: async (_url, request) => { connected.push(request.addresses[0]!.address); return new Response(null, { status: 204 }); },
    });
    expect(lookups).toBe(0);
    expect(connected).toEqual(["93.184.216.34"]);
    await expect(guardedFetch("http://127.0.0.1/feed", { transport: async () => new Response() })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(guardedFetch("http://[fd00::1]/feed", { transport: async () => new Response() })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  test("rejects private IPv6 and mapped IPv4 answers before connecting", async () => {
    for (const address of ["fd00::1", "fe80::1", "::1", "::ffff:10.0.0.1"]) {
      let connections = 0;
      await expect(guardedFetch("https://v6.example/feed", {
        resolver: async () => [{ address: PUBLIC_ADDRESS, family: 4 }, { address, family: 6 }],
        transport: async () => { connections += 1; return new Response(); },
      })).rejects.toBeInstanceOf(UnsafeUrlError);
      expect(connections).toBe(0);
    }
  });

  test("non-GET requests report redirects instead of following them", async () => {
    let connections = 0;
    const response = await guardedFetch("https://hooks.example/callback", {
      method: "POST",
      body: "{}",
      resolver: publicResolver,
      transport: async (_url, request) => {
        connections += 1;
        expect(request.method).toBe("POST");
        expect(request.body).toBe("{}");
        return new Response(null, { status: 307, headers: { location: "https://other.example/" } });
      },
    });
    expect(response.status).toBe(307);
    expect(connections).toBe(1);
  });

  test("the default transport dials the pinned address and keeps the URL's Host", async () => {
    const { createServer } = await import("node:http");
    const { gzipSync } = await import("node:zlib");
    const seen: Array<{ host?: string; method?: string; body: string }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        seen.push({ host: request.headers.host, method: request.method, body });
        response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        response.end(gzipSync("pinned body"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const { pinnedTransport } = await import("./url-guard");
      const response = await pinnedTransport(new URL(`http://unresolvable.invalid:${port}/path?q=1`), {
        addresses: [{ address: "127.0.0.1", family: 4 }],
        method: "POST",
        headers: new Headers({ "x-test": "1" }),
        body: "payload",
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(200);
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(await response.text()).toBe("pinned body");
      expect(response.url).toBe(`http://unresolvable.invalid:${port}/path?q=1`);
      expect(seen).toEqual([{ host: `unresolvable.invalid:${port}`, method: "POST", body: "payload" }]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("TLS connections to a pinned address present the URL hostname as SNI", async () => {
    const { createServer } = await import("node:net");
    // The server name travels in clear text inside the ClientHello.
    const hellos: Buffer[] = [];
    const server = createServer((socket) => {
      socket.once("data", (chunk) => { hellos.push(Buffer.from(chunk)); socket.destroy(); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const { pinnedTransport } = await import("./url-guard");
      await expect(pinnedTransport(new URL(`https://sni.example:${port}/`), {
        addresses: [{ address: "127.0.0.1", family: 4 }],
        method: "GET",
        headers: new Headers(),
        signal: AbortSignal.timeout(5_000),
      })).rejects.toBeDefined();
      expect(hellos).toHaveLength(1);
      expect(hellos[0]!.includes(Buffer.from("sni.example"))).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
