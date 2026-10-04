import type { useSignIn, useSignUp } from "@clerk/nextjs";

export type SignIn = NonNullable<ReturnType<typeof useSignIn>["signIn"]>;
export type SignUp = NonNullable<ReturnType<typeof useSignUp>["signUp"]>;
export type AuthStep = "credentials" | "collect-email" | "verify-sign-up" | "verify-first-factor" | "verify-second-factor" | "reset-password" | "new-password";
export type AuthProgress = { step: AuthStep } | { sessionId: string };

function hasPendingEmailCode(verification: SignIn["firstFactorVerification"] | undefined) {
  return verification?.strategy === "email_code" && verification.status === "unverified" && verification.expireAt && verification.expireAt > new Date();
}

export async function advanceSignUp(signUp: SignUp): Promise<AuthProgress> {
  if (signUp.status === "complete" && signUp.createdSessionId) return { sessionId: signUp.createdSessionId };
  if (signUp.missingFields.includes("email_address")) return { step: "collect-email" };
  if (signUp.missingFields.length) throw new Error("Your account couldn’t be completed. Please try another sign-in method.");
  if (signUp.unverifiedFields.includes("email_address")) {
    const verification = signUp.verifications?.emailAddress;
    if (!hasPendingEmailCode(verification)) {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
    }
    return { step: "verify-sign-up" };
  }
  throw new Error("Your account couldn’t be completed. Please try again.");
}

export async function advanceSignIn(signIn: SignIn, { resend = false } = {}): Promise<AuthProgress> {
  if (signIn.status === "complete" && signIn.createdSessionId) return { sessionId: signIn.createdSessionId };
  if (signIn.status === "needs_new_password") return { step: "new-password" };
  if (signIn.status === "needs_first_factor") {
    const email = signIn.supportedFirstFactors?.find((factor) => factor.strategy === "email_code");
    if (email?.strategy === "email_code") {
      if (resend || !hasPendingEmailCode(signIn.firstFactorVerification)) {
        await signIn.prepareFirstFactor({ strategy: "email_code", emailAddressId: email.emailAddressId });
      }
      return { step: "verify-first-factor" };
    }
  }
  if (signIn.status === "needs_second_factor") {
    const email = signIn.supportedSecondFactors?.find((factor) => factor.strategy === "email_code");
    if (email?.strategy === "email_code") {
      if (resend || !hasPendingEmailCode(signIn.secondFactorVerification)) {
        await signIn.prepareSecondFactor({ strategy: "email_code", emailAddressId: email.emailAddressId });
      }
      return { step: "verify-second-factor" };
    }
  }
  throw new Error("Additional verification couldn’t be started. Please use another sign-in method.");
}

export function supportsPasskeys() {
  return typeof window !== "undefined" && window.isSecureContext && typeof window.PublicKeyCredential !== "undefined";
}
