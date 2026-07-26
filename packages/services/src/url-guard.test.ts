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
      expect((error as UnsafeUrlError).reason).toBe(
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
    const fetchImpl = async (input: string | URL) => {
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
      fetchImpl,
      resolver,
    });

    expect(response.status).toBe(200);
    expect(resolved).toEqual(["feed.example", "cdn.example"]);
    expect(fetched).toHaveLength(2);
  });

  test("rejects a redirect to a private host before a second fetch", async () => {
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://internal.example/secret" },
      });
    };

    await expect(
      guardedFetch("https://public.example/feed", {
        fetchImpl,
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
        fetchImpl: async () => {
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
      fetchImpl: async (_input, init) => {
        seenHeaders.push(new Headers(init?.headers));
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

  test("keeps the timeout active while the response body is consumed", async () => {
    const response = await guardedFetch("https://feed.example/slow", {
      fetchImpl: async (_input, init) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener(
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
