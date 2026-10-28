import { createClerkClient } from "@clerk/backend";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createBearerAuthenticator, isClerkNotFound, type SessionTokenVerifier } from "./clerk";
import { parseStaffAllowlist, resolvePlatformActor } from "./staff";

const WEB_ORIGIN = "https://narriflow-dev.vercel.app";
const API_URL = "http://localhost:4000/api/session/bootstrap";
const publishableKey = `pk_test_${Buffer.from("clerk.example.accounts.dev$").toString("base64")}`;

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwtKey = publicKey.export({ type: "spki", format: "pem" }).toString();
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function sessionToken(
  claims: Record<string, unknown> = {},
  signingKey: typeof privateKey = privateKey,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "ins_test" }));
  const payload = base64url(
    JSON.stringify({
      sub: "user_clerk_1",
      sid: "sess_1",
      azp: WEB_ORIGIN,
      iss: "https://clerk.example.accounts.dev",
      iat: now - 5,
      nbf: now - 5,
      exp: now + 60,
      ...claims,
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(signingKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

// A real Clerk client verifying against a local public key: no network.
const realClient = createClerkClient({
  secretKey: "sk_test_unused",
  publishableKey,
  jwtKey,
  telemetry: { disabled: true },
});
const authenticate = createBearerAuthenticator({
  client: realClient,
  authorizedParties: [WEB_ORIGIN, "http://localhost:3000"],
});

function request(headers: Record<string, string>): Request {
  return new Request(API_URL, { headers });
}

describe("Bearer session verification", () => {
  test("a valid session token yields the verified Clerk user", async () => {
    const result = await authenticate(request({ authorization: `Bearer ${sessionToken()}` }));
    expect(result).toMatchObject({
      status: "authenticated",
      identity: { clerkUserId: "user_clerk_1", sessionId: "sess_1" },
    });
  });

  test("a missing Authorization header is a 401 even when a Clerk cookie is present", async () => {
    const result = await authenticate(request({ cookie: `__session=${sessionToken()}` }));
    expect(result).toEqual({ status: "unauthenticated", reason: "missing_credential" });
  });

  test.each([
    ["a non-Bearer scheme", `Basic ${sessionToken()}`],
    ["an empty token", "Bearer "],
    ["two merged credentials", `Bearer ${sessionToken()}, Bearer ${sessionToken()}`],
    ["whitespace inside the token", "Bearer abc def"],
    ["an oversized token", `Bearer ${"a".repeat(9000)}`],
  ])("%s is malformed even with a valid cookie", async (_name, value) => {
    const result = await authenticate(
      request({ authorization: value, cookie: `__session=${sessionToken()}` }),
    );
    expect(result).toEqual({ status: "unauthenticated", reason: "malformed_credential" });
  });

  test("the Bearer token wins over a different cookie identity", async () => {
    const result = await authenticate(
      request({
        authorization: `Bearer ${sessionToken({ sub: "user_from_header" })}`,
        cookie: `__session=${sessionToken({ sub: "user_from_cookie" })}`,
      }),
    );
    expect(result).toMatchObject({ identity: { clerkUserId: "user_from_header" } });
  });

  test("an expired token is rejected, not treated as an outage", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = sessionToken({ iat: now - 200, nbf: now - 200, exp: now - 100 });
    expect(await authenticate(request({ authorization: `Bearer ${token}` }))).toEqual({
      status: "unauthenticated",
      reason: "rejected_token",
    });
  });

  test("a token signed by another key is rejected", async () => {
    const token = sessionToken({}, otherKey);
    expect(await authenticate(request({ authorization: `Bearer ${token}` }))).toEqual({
      status: "unauthenticated",
      reason: "rejected_token",
    });
  });

  test("a token minted for an unlisted frontend origin is rejected", async () => {
    const token = sessionToken({ azp: "https://evil.example" });
    expect(await authenticate(request({ authorization: `Bearer ${token}` }))).toEqual({
      status: "unauthenticated",
      reason: "rejected_token",
    });
  });

  test.each(["ak_live_abcdef0123456789", "oat_abcdef0123456789", "mt_abcdef0123456789"])(
    "machine token %s is not accepted as a session",
    async (token) => {
      expect(await authenticate(request({ authorization: `Bearer ${token}` }))).toEqual({
        status: "unauthenticated",
        reason: "rejected_token",
      });
    },
  );

  test("Clerk only ever sees the Authorization header, never cookies", async () => {
    const seen: Headers[] = [];
    const spy = {
      authenticateRequest: async (clerkRequest: Request) => {
        seen.push(clerkRequest.headers);
        return { status: "signed-out", tokenType: "session_token", reason: "x" };
      },
    } as unknown as SessionTokenVerifier;
    await createBearerAuthenticator({ client: spy, authorizedParties: [WEB_ORIGIN] })(
      request({ authorization: "Bearer abc.def.ghi", cookie: "__session=abc; __client_uat=1" }),
    );
    expect([...(seen[0] ?? new Headers()).keys()]).toEqual(["authorization"]);
  });

  test("a pending or userless session is not authenticated", async () => {
    const stub = {
      authenticateRequest: async () => ({
        status: "signed-in",
        tokenType: "session_token",
        reason: null,
        toAuth: () => ({ userId: null, sessionId: null }),
      }),
    } as unknown as SessionTokenVerifier;
    const result = await createBearerAuthenticator({ client: stub, authorizedParties: [WEB_ORIGIN] })(
      request({ authorization: "Bearer abc.def.ghi" }),
    );
    expect(result).toEqual({ status: "unauthenticated", reason: "rejected_token" });
  });
});

describe("provider outage", () => {
  let warn: ReturnType<typeof spyOn<Console, "warn">>;
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const outageClient = (state: unknown) =>
    ({ authenticateRequest: async () => state }) as unknown as SessionTokenVerifier;
  const withClient = (client: SessionTokenVerifier) =>
    createBearerAuthenticator({ client, authorizedParties: [WEB_ORIGIN] });
  const bearer = request({ authorization: "Bearer abc.def.ghi" });

  test.each([
    "jwk-remote-failed-to-load",
    "jwk-remote-invalid",
    "jwk-remote-missing",
    "jwk-failed-to-resolve",
    "jwk-local-missing",
    "secret-key-invalid",
    "unexpected-error",
  ])("reason %s is a 503, not a sign-out", async (reason) => {
    const result = await withClient(outageClient({ status: "signed-out", tokenType: "session_token", reason }))(
      bearer,
    );
    expect(result).toEqual({ status: "unavailable" });
  });

  test("a thrown Clerk client error is a 503 and its message is never surfaced", async () => {
    const throwing = {
      authenticateRequest: async () => {
        throw new Error("connect ECONNREFUSED clerk.internal sk_live_secret");
      },
    } as unknown as SessionTokenVerifier;
    expect(await withClient(throwing)(bearer)).toEqual({ status: "unavailable" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sk_live_secret");
  });

  test("a handshake state is a plain 401 result, never a redirect", async () => {
    const result = await withClient(
      outageClient({ status: "handshake", tokenType: "session_token", reason: "session-token-expired" }),
    )(bearer);
    expect(result).toEqual({ status: "unauthenticated", reason: "rejected_token" });
  });
});

describe("authorized parties configuration", () => {
  const client = { authenticateRequest: async () => ({}) } as unknown as SessionTokenVerifier;

  test("refuses an empty list because Clerk would then skip the azp check", () => {
    expect(() => createBearerAuthenticator({ client, authorizedParties: [] })).toThrow(
      "CLERK_AUTHORIZED_PARTIES",
    );
  });

  test.each(["https://*.vercel.app", "narriflow-dev.vercel.app", "https://app.example/path", "https://a.example/"])(
    "refuses %s because entries must be exact full origins",
    (entry) => {
      expect(() => createBearerAuthenticator({ client, authorizedParties: [entry] })).toThrow(
        "full origins",
      );
    },
  );
});

describe("Clerk 404 detection", () => {
  class ClerkAPIResponseError extends Error {
    static kind = "ClerkAPIResponseError";
    constructor(readonly status: number) {
      super("x");
    }
  }

  test("accepts only a Clerk API response error with status 404", () => {
    expect(isClerkNotFound(new ClerkAPIResponseError(404))).toBe(true);
    expect(isClerkNotFound(new ClerkAPIResponseError(500))).toBe(false);
    expect(isClerkNotFound(Object.assign(new Error("x"), { status: 404 }))).toBe(false);
    expect(isClerkNotFound(null)).toBe(false);
    expect(isClerkNotFound("404")).toBe(false);
  });
});

describe("platform staff", () => {
  test("only an exact allowlisted Clerk user id resolves to staff, and the list is empty by default", async () => {
    const staff = await authenticate(
      request({ authorization: `Bearer ${sessionToken({ sub: "user_staff", role: "admin", staff: true })}` }),
    );
    const member = await authenticate(
      request({ authorization: `Bearer ${sessionToken({ sub: "user_staff_2", org_role: "org:admin" })}` }),
    );
    if (staff.status !== "authenticated" || member.status !== "authenticated") throw new Error("setup");

    expect(resolvePlatformActor(staff.identity, parseStaffAllowlist(undefined))).toBeNull();
    expect(resolvePlatformActor(staff.identity, parseStaffAllowlist(""))).toBeNull();

    const allowlist = parseStaffAllowlist(" user_staff , ,user_other ");
    expect(resolvePlatformActor(staff.identity, allowlist)).toEqual({
      kind: "platform_staff",
      clerkUserId: "user_staff",
    });
    expect(resolvePlatformActor(member.identity, allowlist)).toBeNull();
    expect(resolvePlatformActor(member.identity, parseStaffAllowlist("user_staff"))).toBeNull();
  });
});
