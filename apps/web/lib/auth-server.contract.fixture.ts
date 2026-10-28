import { beforeEach, describe, expect, mock, test } from "bun:test";
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
mock.module("@clerk/nextjs/server", () => ({ clerkMiddleware: (handler: unknown) => handler, createRouteMatcher }));
const { default: proxy } = await import("../proxy");

beforeEach(() => {
  userId = null;
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

// Identity continuation is a client flow now (`resolveAuthContinuation`, covered by
// post-auth-redirect.test.ts); API requests no longer pass through this proxy.
describe("authentication proxy page contracts with installed Clerk protect", () => {
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
});
