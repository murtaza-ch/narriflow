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
      .toBe("http://localhost:3000/onboarding");
  });

  test("rejects non-OAuth paths on the Clerk issuer", () => {
    expect(resolvePostAuthRedirect(`${clerkIssuer}/other`, appOrigin, clerkIssuer).href)
      .toBe("http://localhost:3000/onboarding");
  });

  test("rejects non-consent paths on the Clerk consent origin", () => {
    expect(resolvePostAuthRedirect(
      "https://accounts.example.com/other",
      appOrigin,
      clerkIssuer,
      "https://accounts.example.com",
    ).href).toBe("http://localhost:3000/onboarding");
  });
});
