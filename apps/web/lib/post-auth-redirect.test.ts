import { describe, expect, test } from "bun:test";
import { resolvePostAuthRedirect } from "./post-auth-redirect";

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
