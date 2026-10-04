import { describe, expect, mock, test } from "bun:test";
import { advanceSignIn, advanceSignUp, type SignIn, type SignUp } from "./auth-flow";
import { authContinuationHref, authEntryHref, oauthCallbackHref } from "./auth-entry";

function signup(fields: Partial<SignUp>) {
  return { status: "missing_requirements", missingFields: [], unverifiedFields: [], ...fields } as SignUp;
}

describe("authentication completion", () => {
  test("email registration waits for verification before activating a session", async () => {
    const prepare = mock(async () => ({} as SignUp));
    expect(await advanceSignUp(signup({ unverifiedFields: ["email_address"], prepareEmailAddressVerification: prepare }))).toEqual({ step: "verify-sign-up" });
    expect(prepare).toHaveBeenCalledWith({ strategy: "email_code" });
    expect(await advanceSignUp(signup({ status: "complete", createdSessionId: "verified-session" }))).toEqual({ sessionId: "verified-session" });
  });

  test("OAuth profiles with a verified email need no profile form", async () => {
    expect(await advanceSignUp(signup({ status: "complete", createdSessionId: "oauth-session", firstName: null, lastName: null }))).toEqual({ sessionId: "oauth-session" });
  });

  test("OAuth without an email collects only email, then verifies it", async () => {
    expect(await advanceSignUp(signup({ missingFields: ["email_address"] }))).toEqual({ step: "collect-email" });
    const prepare = mock(async () => ({} as SignUp));
    expect(await advanceSignUp(signup({ unverifiedFields: ["email_address"], prepareEmailAddressVerification: prepare }))).toEqual({ step: "verify-sign-up" });
  });

  test("password, returning OAuth, reset, and passkey completion use the same handoff", async () => {
    expect(await advanceSignIn({ status: "complete", createdSessionId: "session" } as SignIn)).toEqual({ sessionId: "session" });
    expect(await advanceSignIn({ status: "needs_new_password" } as SignIn)).toEqual({ step: "new-password" });
  });

  test("password sign-in handles Clerk's additional email verification", async () => {
    const prepareFirstFactor = mock(async () => ({} as SignIn));
    expect(await advanceSignIn({ status: "needs_first_factor", supportedFirstFactors: [{ strategy: "email_code", emailAddressId: "email", safeIdentifier: "a***@example.com" }], prepareFirstFactor } as unknown as SignIn)).toEqual({ step: "verify-first-factor" });
    expect(prepareFirstFactor).toHaveBeenCalledWith({ strategy: "email_code", emailAddressId: "email" });
  });

  test.each(["first", "second"] as const)("%s-factor codes are reused until expiry or explicit resend", async (factor) => {
    const prepare = mock(async () => ({} as SignIn));
    const verification = { strategy: "email_code", status: "unverified", expireAt: new Date(Date.now() + 60_000) };
    const signIn = { status: factor === "first" ? "needs_first_factor" : "needs_second_factor", [factor === "first" ? "supportedFirstFactors" : "supportedSecondFactors"]: [{ strategy: "email_code", emailAddressId: "email" }], [factor === "first" ? "firstFactorVerification" : "secondFactorVerification"]: verification, [factor === "first" ? "prepareFirstFactor" : "prepareSecondFactor"]: prepare } as unknown as SignIn;
    await advanceSignIn(signIn); expect(prepare).not.toHaveBeenCalled();
    await advanceSignIn(signIn, { resend: true }); expect(prepare).toHaveBeenCalledTimes(1);
    verification.expireAt = new Date(Date.now() - 1);
    await advanceSignIn(signIn); expect(prepare).toHaveBeenCalledTimes(2);
  });

  test("configuration mistakes do not silently activate an incomplete account", async () => {
    await expect(advanceSignUp(signup({ missingFields: ["username"] }))).rejects.toThrow("couldn’t be completed");
    await expect(advanceSignIn({ status: "needs_identifier" } as SignIn)).rejects.toThrow("verification");
  });

  test.each(["/projects/abc?clip=123#preview", "/workspaces/invitations/token", "/upload?source=example", "https://accounts.example.com/oauth-consent?client_id=abc&scope=read"])("preserves %s while switching modes and returning from OAuth", (destination) => {
    for (const mode of ["sign-in", "sign-up", "forgot-password", "continue"] as const) {
      const url = new URL(authEntryHref(mode, destination), "https://app.example.com");
      expect(url.searchParams.get("auth")).toBe(mode);
      expect(url.searchParams.get("redirect_url")).toBe(destination);
    }
    for (const href of [authContinuationHref(destination), oauthCallbackHref(destination)]) {
      expect(new URL(href, "https://app.example.com").searchParams.get("redirect_url")).toBe(destination);
    }
  });
});
