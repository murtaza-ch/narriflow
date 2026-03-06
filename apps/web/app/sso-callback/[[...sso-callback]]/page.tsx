import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

export default function SSOCallbackPage() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-6 py-10">
      <div className="w-full rounded-xl border border-border bg-card p-6">
        <AuthenticateWithRedirectCallback
          continueSignUpUrl="/sign-up/continue"
          signInFallbackRedirectUrl="/onboarding"
          signInUrl="/sign-in"
          signUpFallbackRedirectUrl="/onboarding"
        />
        <div id="clerk-captcha" />
      </div>
    </div>
  );
}
