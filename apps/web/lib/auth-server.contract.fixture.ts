import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";

const sdk = createRequire(import.meta.resolve("@clerk/nextjs"));
const { createRouteMatcher } = sdk("@clerk/nextjs/server");
const { createProtect } = createRequire(sdk.resolve("@clerk/nextjs/server"))("./protect.js");
class RequestOutcome extends Error {
  constructor(public status: number, public location?: string) { super(`Request ended with ${status}`); }
}
let request: NextRequest;
let userId: string | null;
const auth = Object.assign(async () => ({ userId }), {
  protect: async (...args: unknown[]) => createProtect({
    request,
    authObject: { userId, tokenType: "session_token", sessionStatus: userId ? "active" : null },
    redirect: (url: string) => { throw new RequestOutcome(307, url); },
    redirectToSignIn: () => { throw new RequestOutcome(307, "https://accounts.example.test/sign-in"); },
    notFound: () => { throw new RequestOutcome(404); },
    unauthorized: () => { throw new RequestOutcome(401); },
  })(...args),
});
const admitSignedInPage = mock(async (_destination: string) => ({ id: "app-user" }));
let requestHeaders: Headers;
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
mock.module("@clerk/nextjs/server", () => ({ clerkMiddleware: (handler: unknown) => handler, createRouteMatcher }));
mock.module("./authenticated-request-page", () => ({ admitSignedInPage }));
mock.module("next/headers", () => ({ headers: async () => requestHeaders }));
mock.module("next/navigation", () => ({ redirect: (url: string) => { throw new RequestOutcome(307, url); } }));
const { default: proxy } = await import("../proxy");
const { default: continuePage } = await import("../app/auth/continue/page");

beforeEach(() => {
  userId = null;
  requestHeaders = new Headers({ host: "localhost:3000" });
  admitSignedInPage.mockClear();
  process.env.NEXT_PUBLIC_APP_URL = "https://fallback.example.test";
});
afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
});

async function runProxy(path: string, method = "GET", accept = "application/json") {
  request = new NextRequest(new URL(path, "https://narriflow.example.test"), { method, headers: { accept } });
  try {
    return await (proxy as any)(auth, request);
  } catch (error) {
    if (error instanceof RequestOutcome) return { status: error.status, headers: new Headers(error.location ? { location: error.location } : {}) };
    throw error;
  }
}

describe("authentication proxy request contracts with installed Clerk protect", () => {
  test.each(["/api/projects?cursor=abc", "/api/upload-sessions", "/api/stream/project/abc", "/api/social/accounts"])("signed-out %s fetch is rejected without a redirect", async (path) => {
    const response = await runProxy(path);
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(await (response as Response).json()).toEqual({ error: "Unauthorized" });
  });
  test.each(["POST", "PATCH", "DELETE"])("signed-out API %s cannot forward its method to the homepage", async (method) => {
    const response = await runProxy("/api/projects/abc", method);
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });
  test("a signed-out application page opens the modal with its complete destination", async () => {
    const response = await runProxy("/projects/abc?clip=123", "GET", "text/html");
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/");
    expect(location.searchParams.get("auth")).toBe("sign-in");
    expect(location.searchParams.get("redirect_url")).toBe("https://narriflow.example.test/projects/abc?clip=123");
  });
  test("unsigned continuation keeps its destination instead of nesting an auth redirect", async () => {
    const destination = "/invite/token?accept=1";
    const response = await runProxy(`/auth/continue?${new URLSearchParams({ redirect_url: destination })}`, "GET", "text/html");
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("auth")).toBe("sign-in");
    expect(location.searchParams.get("redirect_url")).toBe(destination);
  });
  test.each(["sign-in", "sign-up", "forgot-password", "continue"])("signed-in %s proceeds through provisioning", async (mode) => {
    userId = "clerk-user";
    const response = await runProxy(`/?${new URLSearchParams({ auth: mode, redirect_url: "/upload?source=abc" })}`);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/auth/continue");
    expect(location.searchParams.get("redirect_url")).toBe("/upload?source=abc");
  });
  test("authenticated API requests proceed without a homepage redirect", async () => {
    userId = "clerk-user";
    expect((await runProxy("/api/projects")).headers.get("location")).toBeNull();
  });
});

describe("identity continuation page", () => {
  test.each([
    { host: "localhost:3000", protocol: null, origin: "http://localhost:3000" },
    { host: "narriflow-dev.vercel.app", protocol: "https", origin: "https://narriflow-dev.vercel.app" },
    { host: null, protocol: null, origin: "https://fallback.example.test" },
  ])("validates the destination against the request origin $origin", async ({ host, protocol, origin }) => {
    requestHeaders = new Headers();
    if (host) requestHeaders.set("host", host);
    if (protocol) requestHeaders.set("x-forwarded-proto", protocol);
    const destination = `${origin}/projects/abc?clip=123#preview`;
    try { await continuePage({ searchParams: Promise.resolve({ redirect_url: destination }) }); throw new Error("Expected redirect"); }
    catch (error) {
      expect(error).toBeInstanceOf(RequestOutcome);
      expect((error as RequestOutcome).location).toBe(destination);
    }
    expect(admitSignedInPage).toHaveBeenCalledWith(destination);
  });
  test("database failure reaches the error boundary and a retry can provision and redirect", async () => {
    admitSignedInPage.mockRejectedValueOnce(new Error("Injected database outage"));
    const props = { searchParams: Promise.resolve({ redirect_url: "/invite/token" }) };
    await expect(continuePage(props)).rejects.toThrow("Injected database outage");
    try { await continuePage(props); throw new Error("Expected redirect"); }
    catch (error) { expect((error as RequestOutcome).location).toBe("http://localhost:3000/invite/token"); }
    expect(admitSignedInPage).toHaveBeenCalledTimes(2);
  });
  test("untrusted destinations default to home after identity provisioning", async () => {
    try { await continuePage({ searchParams: Promise.resolve({ redirect_url: "https://evil.example.test/" }) }); throw new Error("Expected redirect"); }
    catch (error) { expect((error as RequestOutcome).location).toBe("http://localhost:3000/home"); }
    expect(admitSignedInPage).toHaveBeenCalledTimes(1);
  });
});
