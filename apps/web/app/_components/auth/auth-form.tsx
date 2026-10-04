"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSignIn, useSignUp } from "@clerk/nextjs";
import { Box, Dialog, Flex, Stack, Text } from "@chakra-ui/react";
import { KeyRound } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { LabeledDivider } from "@narriflow/ui/components/divider";
import { authContinuationHref, authEntryHref, oauthCallbackHref, type AuthMode } from "@/lib/auth-entry";
import { advanceSignIn, advanceSignUp, supportsPasskeys, type AuthProgress, type AuthStep, type SignIn, type SignUp } from "@/lib/auth-flow";
import { PasswordInput } from "./password-input";
import { OAuthButtonRow, type OAuthStrategy } from "./oauth-buttons";
import { FormError } from "./form-error";
import { ResendButton } from "./resend-button";
import { getClerkErrorMessage } from "./clerk-error";

export function AuthForm({ mode, destination }: { mode: AuthMode; destination: string | null }) {
  const router = useRouter();
  const signInHook = useSignIn();
  const signUpHook = useSignUp();
  const [formMode, setFormMode] = useState(mode);
  const [step, setStep] = useState<AuthStep>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [oauth, setOAuth] = useState<OAuthStrategy | null>(null);
  const [passkeysSupported, setPasskeysSupported] = useState(false);
  const busy = useRef(false);
  const continuationStarted = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const loaded = signInHook.isLoaded && signUpHook.isLoaded;
  const completion = authContinuationHref(destination);

  useEffect(() => { setPasskeysSupported(supportsPasskeys()); }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Announce the new form step when its heading changes.
  useEffect(() => { titleRef.current?.focus(); }, [step]);

  const finish = useCallback(async (progress: AuthProgress) => {
    if ("sessionId" in progress) {
      await signInHook.setActive?.({ session: progress.sessionId });
      router.replace(completion);
      router.refresh();
    } else {
      setStep(progress.step);
      setCode("");
    }
  }, [signInHook.setActive, router, completion]);

  const run = useCallback(async (operation: () => Promise<void>) => {
    if (busy.current || !loaded) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await operation();
      return true;
    } catch (failure) {
      setError(getClerkErrorMessage(failure, "Authentication couldn't finish. Please try again or choose another method."));
      return false;
    } finally {
      busy.current = false;
      setPending(false);
      setOAuth(null);
    }
  }, [loaded]);

  useEffect(() => {
    if (!loaded || continuationStarted.current) return;
    continuationStarted.current = true;
    const attempt = signUpHook.signUp;
    const signIn = signInHook.signIn;
    const callbackError = mode === "sign-up" || mode === "continue"
      ? attempt?.verifications?.externalAccount?.error
      : mode === "sign-in" ? signIn?.firstFactorVerification.error : null;
    if (callbackError) {
      setError(getClerkErrorMessage({ errors: [callbackError] }, "Authentication couldn't finish. Please choose another method."));
      return;
    }
    if (mode === "continue" || (mode === "sign-up" && attempt?.status)) {
      if (!attempt?.status) {
        router.replace(authEntryHref("sign-up", destination));
        return;
      }
      setEmail(attempt.emailAddress ?? "");
      void run(async () => { await finish(await advanceSignUp(attempt)); });
    } else if (mode === "forgot-password" && signInHook.signIn?.firstFactorVerification.strategy === "reset_password_email_code") {
      setEmail(signInHook.signIn.identifier ?? "");
      setStep(signInHook.signIn.status === "needs_new_password" ? "new-password" : "reset-password");
    } else if (mode === "sign-in" && signInHook.signIn?.status === "needs_new_password") {
      setStep("new-password");
    } else if (mode === "sign-in" && signIn && signIn.firstFactorVerification.strategy !== "reset_password_email_code" && (
      (signIn.status === "needs_first_factor" && signIn.supportedFirstFactors?.some((factor) => factor.strategy === "email_code")) ||
      (signIn.status === "needs_second_factor" && signIn.supportedSecondFactors?.some((factor) => factor.strategy === "email_code"))
    )) {
      setEmail(signIn.identifier ?? "");
      void run(async () => { await finish(await advanceSignIn(signIn)); });
    }
  }, [mode, loaded, destination, router, signUpHook.signUp, signInHook.signIn, finish, run]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      const signIn = signInHook.signIn as SignIn;
      const signUp = signUpHook.signUp as SignUp;
      if (step === "verify-sign-up") {
        await finish(await advanceSignUp(await signUp.attemptEmailAddressVerification({ code })));
      } else if (step === "collect-email") {
        await finish(await advanceSignUp(await signUp.update({ emailAddress: email.trim() })));
      } else if (step === "verify-first-factor") {
        await finish(await advanceSignIn(await signIn.attemptFirstFactor({ strategy: "email_code", code })));
      } else if (step === "verify-second-factor") {
        await finish(await advanceSignIn(await signIn.attemptSecondFactor({ strategy: "email_code", code })));
      } else if (step === "reset-password") {
        await finish(await advanceSignIn(await signIn.attemptFirstFactor({ strategy: "reset_password_email_code", code, password })));
      } else if (step === "new-password") {
        await finish(await advanceSignIn(await signIn.resetPassword({ password })));
      } else if (formMode === "forgot-password") {
        await signIn.create({ strategy: "reset_password_email_code", identifier: email.trim() });
        setStep("reset-password");
      } else if (formMode === "sign-up") {
        await finish(await advanceSignUp(await signUp.create({ emailAddress: email.trim(), password })));
      } else {
        await finish(await advanceSignIn(await signIn.create({ identifier: email.trim(), password })));
      }
    });
  }

  async function startOAuth(strategy: OAuthStrategy) {
    await run(async () => {
      setOAuth(strategy);
      const attempt = formMode === "sign-up" ? signUpHook.signUp : signInHook.signIn;
      await attempt?.authenticateWithRedirect({ strategy, redirectUrl: oauthCallbackHref(destination), redirectUrlComplete: completion });
    });
  }

  async function signInWithPasskey() {
    await run(async () => {
      const result = await signInHook.signIn?.authenticateWithPasskey({ flow: "discoverable" });
      if (result) await finish(await advanceSignIn(result));
    });
  }

  async function resend() {
    return run(async () => {
      if (step === "verify-sign-up") await signUpHook.signUp?.prepareEmailAddressVerification({ strategy: "email_code" });
      else if (step === "reset-password") {
        const factor = signInHook.signIn?.supportedFirstFactors?.find((f) => f.strategy === "reset_password_email_code");
        if (factor?.strategy !== "reset_password_email_code") throw new Error("Please start password recovery again.");
        await signInHook.signIn?.prepareFirstFactor({ strategy: "reset_password_email_code", emailAddressId: factor.emailAddressId });
      } else if (signInHook.signIn) await advanceSignIn(signInHook.signIn, { resend: true });
    });
  }

  function startOver() {
    if (busy.current) return;
    setFormMode(mode === "continue" ? "sign-up" : mode);
    setStep("credentials");
    setEmail("");
    setPassword("");
    setCode("");
    setError(null);
  }

  const verifying = step.startsWith("verify-");
  const showProviders = step === "credentials" && (formMode === "sign-in" || formMode === "sign-up");
  const showEmail = step === "collect-email" || (step === "credentials" && formMode !== "continue");
  const showPassword = step === "reset-password" || step === "new-password" || (step === "credentials" && showProviders);
  const showCode = verifying || step === "reset-password";
  const title = verifying ? "Verify your email" : step === "collect-email" ? "Add your email" : step === "reset-password" || step === "new-password" ? "Set a new password" : formMode === "forgot-password" ? "Reset your password" : formMode === "sign-up" ? "Create your account" : formMode === "continue" ? "Complete your account" : "Sign in to Narriflow";
  const submitLabel = verifying ? "Verify email" : step === "collect-email" ? "Continue" : step === "reset-password" || step === "new-password" ? "Save password" : formMode === "forgot-password" ? "Send reset code" : formMode === "sign-up" ? "Create free account" : "Sign in";

  return <Stack gap="5" aria-busy={pending}>
    <Stack gap="2" pe="5">
      <Text color="accent.fg" fontSize="sm" fontWeight="600">Narriflow</Text>
      <Dialog.Title ref={titleRef} tabIndex={-1} outline="none" fontFamily="display" fontSize="2xl" lineHeight="1.2">{title}</Dialog.Title>
      <Dialog.Description color="fg.muted" fontSize="sm">
        {showCode ? `Enter the code sent to ${email || "your email"}.` : step === "collect-email" ? "Use an email address to secure your account." : formMode === "forgot-password" ? "We’ll email you a code to reset your password." : "Your free workspace is ready when you are."}
      </Dialog.Description>
    </Stack>
    {showProviders && <>
      <OAuthButtonRow pending={oauth} disabled={!loaded || pending} onSelect={startOAuth} />
      {formMode === "sign-in" && passkeysSupported && <Button variant="outline" type="button" disabled={!loaded || pending} onClick={signInWithPasskey}><KeyRound size={17} />Sign in with a passkey</Button>}
      <LabeledDivider label="or use email" />
    </>}
    <form onSubmit={submit}>
      <Stack gap="4">
        {showEmail && <Stack gap="1.5">
          <Label htmlFor="auth-email">Email</Label>
          <Input id="auth-email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" disabled={pending} />
        </Stack>}
        {showCode && <Stack gap="1.5">
          <Label htmlFor="auth-code">Verification code</Label>
          <Input id="auth-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} disabled={pending} />
        </Stack>}
        {showPassword && <Stack gap="1.5">
          <Flex justify="space-between" align="center">
            <Label htmlFor="auth-password">{step === "credentials" ? "Password" : "New password"}</Label>
            {formMode === "sign-in" && step === "credentials" && <Link href={authEntryHref("forgot-password", destination)} replace scroll={false} aria-disabled={pending} onClick={(e) => { if (pending) e.preventDefault(); }}><Text as="span" color="fg.muted" fontSize="xs" textDecoration="underline">Forgot password?</Text></Link>}
          </Flex>
          <PasswordInput id="auth-password" name="password" autoComplete={formMode === "sign-in" && step === "credentials" ? "current-password" : "new-password"} required value={password} onChange={(e) => setPassword(e.target.value)} disabled={pending} />
        </Stack>}
        <Box id="clerk-captcha" />
        <FormError message={error} />
        {formMode === "continue" && step === "credentials" && error && <Button type="button" onClick={() => run(async () => { if (signUpHook.signUp) await finish(await advanceSignUp(signUpHook.signUp)); })} disabled={pending}>Try again</Button>}
        {(showEmail || showPassword || showCode) && <Button type="submit" width="full" loading={pending} disabled={!loaded}>{submitLabel}</Button>}
        {showCode && <ResendButton onResend={resend} disabled={pending} />}
        {(step !== "credentials" || (formMode === "continue" && error)) && <Button type="button" variant="ghost" disabled={pending} onClick={startOver}>Use a different email</Button>}
      </Stack>
    </form>
    <Text textAlign="center" fontSize="sm" color="fg.muted">
      {formMode === "sign-up" || formMode === "continue" ? "Already have an account? " : formMode === "forgot-password" ? "Back to " : "New to Narriflow? "}
      <Link href={authEntryHref(formMode === "sign-in" ? "sign-up" : "sign-in", destination)} replace scroll={false} aria-disabled={pending} onClick={(e) => { if (pending) e.preventDefault(); }}><Text as="span" color="fg" fontWeight="500" textDecoration="underline">{formMode === "sign-in" ? "Create an account" : "Sign in"}</Text></Link>
    </Text>
  </Stack>;
}
