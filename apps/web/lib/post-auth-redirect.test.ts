import { describe, expect, test } from "bun:test";
import { resolveAuthContinuation, resolvePostAuthRedirect } from "./post-auth-redirect";

const appOrigin = "http://localhost:3000";
const clerkIssuer = "https://clerk.example.test";

describe("resolvePostAuthRedirect", () => {
  test("allows same-origin continuations", () => {
    expect(resolvePostAuthRedirect("/invite/abc", appOrigin, clerkIssuer).href)
      .toBe("http://localhost:3000/invite/abc");
  });

  test("allows Clerk's immediate OAuth continuation", () => {
    const target = `${clerkIssuer}/oauth/authorize-with-immediate-redirect?client_id=test`;
    expect(resolvePostAuthRedirect(target, appOrigin, clerkIssuer).href).toBe(target);
  });

  test("allows the derived Clerk development consent origin", () => {
    const developmentIssuer = "https://ideal-midge-4.clerk.accounts.dev";
    const target = "https://ideal-midge-4.accounts.dev/oauth-consent?client_id=test";
    expect(resolvePostAuthRedirect(target, appOrigin, developmentIssuer).href).toBe(target);
  });

  test("allows an explicitly configured production consent origin", () => {
    const target = "https://accounts.example.com/oauth-consent?client_id=test";
    expect(resolvePostAuthRedirect(target, appOrigin, clerkIssuer, "https://accounts.example.com").href)
      .toBe(target);
  });

  test("rejects arbitrary external redirects", () => {
    expect(resolvePostAuthRedirect("https://evil.example/steal", appOrigin, clerkIssuer).href)
      .toBe("http://localhost:3000/home");
  });

  test("rejects non-OAuth paths on the Clerk issuer", () => {
    expect(resolvePostAuthRedirect(`${clerkIssuer}/other`, appOrigin, clerkIssuer).href)
      .toBe("http://localhost:3000/home");
  });

  test("rejects non-consent paths on the Clerk consent origin", () => {
    expect(resolvePostAuthRedirect(
      "https://accounts.example.com/other",
      appOrigin,
      clerkIssuer,
      "https://accounts.example.com",
    ).href).toBe("http://localhost:3000/home");
  });
  test.each([null, "/?auth=sign-in", "/?auth=sign-up&redirect_url=/home", "/auth/continue", "/auth/continue/", "/%61uth/continue", "/sso-callback", "/sign-in", "/sign-up/continue", "/onboarding", "javascript:alert(1)", "//evil.example/home", "https://user:password@localhost:3000/home"])("defaults to home for missing or unsafe destination %s", (destination) => {
    expect(resolvePostAuthRedirect(destination, appOrigin, clerkIssuer).href).toBe(`${appOrigin}/home`);
  });
  test("preserves project query parameters and fragments", () => {
    const destination = "/projects/123?clip=456#preview";
    expect(resolvePostAuthRedirect(destination, appOrigin, clerkIssuer).href).toBe(`${appOrigin}${destination}`);
  });

});

describe("resolveAuthContinuation", () => {
  const config = { issuerUrl: "https://example.clerk.accounts.dev", consentOrigin: null };

  test("an approved Clerk authorization page keeps its SDK hand-off", () => {
    const destination = `${config.issuerUrl}/oauth/authorize-with-immediate-redirect?client_id=test&state=original`;
    expect(resolveAuthContinuation(destination, appOrigin, config)).toEqual({ kind: "clerk", href: destination });
  });

  test("a page of this app is followed as a path with its query and fragment", () => {
    expect(resolveAuthContinuation(`${appOrigin}/projects/abc?clip=123#preview`, appOrigin, config)).toEqual({
      kind: "app",
      path: "/projects/abc?clip=123#preview",
    });
    expect(resolveAuthContinuation("/invite/token", appOrigin, config)).toEqual({ kind: "app", path: "/invite/token" });
  });

  test("untrusted or missing destinations default to home", () => {
    for (const destination of ["https://evil.example.test/", null, "/auth/continue"]) {
      expect(resolveAuthContinuation(destination, appOrigin, config)).toEqual({ kind: "app", path: "/home" });
    }
  });

  test("without API-supplied Clerk configuration no external destination is followed", () => {
    const destination = "https://example.clerk.accounts.dev/oauth/authorize-with-immediate-redirect?client_id=test";
    expect(resolveAuthContinuation(destination, appOrigin, { issuerUrl: null, consentOrigin: null })).toEqual({
      kind: "app",
      path: "/home",
    });
  });
});
