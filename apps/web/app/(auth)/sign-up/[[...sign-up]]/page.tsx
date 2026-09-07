"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSignUp } from "@clerk/nextjs";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { Spinner } from "@narriflow/ui/components/spinner";
import { OTPInput } from "@narriflow/ui/components/otp-input";
import { LabeledDivider } from "@narriflow/ui/components/divider";
import { AuthHeader } from "../../../components/auth-shell";
import { OAuthButtonRow, type OAuthStrategy } from "../../_components/oauth-buttons";
import { PasswordInput } from "../../_components/password-input";
import { FormError } from "../../_components/form-error";
import { ResendButton } from "../../_components/resend-button";
import { getClerkErrorMessage } from "../../_lib/clerk-error";

const CODE_LENGTH = 6;

export default function SignUpPage() {
  const router = useRouter();
  const { isLoaded, signUp, setActive } = useSignUp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<OAuthStrategy | null>(null);

  async function onCreateAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLoaded || !signUp) return;

    setSubmitting(true);
    setError(null);

    try {
      // Names are collected later, during onboarding — the sign-up card
      // stays a two-field form.
      await signUp.create({
        emailAddress: email.trim(),
        password,
      });
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setAwaitingVerification(true);
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Sign up failed. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyCode(code: string) {
    if (!isLoaded || !signUp || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const result = await signUp.attemptEmailAddressVerification({
        code: code.trim(),
      });
      if (result.status !== "complete") {
        setError("Verification is incomplete. Please enter the latest code.");
        return;
      }
      await setActive({ session: result.createdSessionId });
      router.push("/onboarding");
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Verification failed. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  async function onVerifyEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await verifyCode(verificationCode);
  }

  async function onResendCode(): Promise<boolean> {
    if (!isLoaded || !signUp) return false;

    setError(null);

    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      return true;
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Unable to resend code. Please try again."));
      return false;
    }
  }

  async function onOAuthSignUp(strategy: OAuthStrategy) {
    if (!isLoaded || !signUp) return;

    setError(null);
    setOauthLoading(strategy);

    try {
      await signUp.authenticateWithRedirect({
        strategy,
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/onboarding",
      });
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Sign up failed. Please try again."));
      setOauthLoading(null);
    }
  }

  return (
    <Stack gap="7">
      <AuthHeader
        eyebrow={awaitingVerification ? "Check your inbox" : "Create account"}
        title={awaitingVerification ? "Verify your email" : "Start clipping"}
        description={
          awaitingVerification ? (
            <>
              We sent a {CODE_LENGTH}-digit code to{" "}
              <Box as="span" fontWeight="500" color="fg">
                {email}
              </Box>
              .
            </>
          ) : (
            "Clip your first upload in minutes."
          )
        }
      />

      {awaitingVerification ? (
        <form onSubmit={onVerifyEmail}>
          <Stack gap="4" animation="fade-up">
            <Flex justify="center" py="2">
              <OTPInput
                length={CODE_LENGTH}
                value={verificationCode}
                onValueChange={setVerificationCode}
                onComplete={(code) => void verifyCode(code)}
                autoFocus
                disabled={submitting}
              />
            </Flex>

            <FormError message={error} />

            <Button
              width="full"
              disabled={submitting || verificationCode.trim().length < CODE_LENGTH}
              type="submit"
            >
              {submitting ? (
                <>
                  <Spinner size="xs" borderTopColor="accent.contrast" />
                  Verifying…
                </>
              ) : (
                "Verify email"
              )}
            </Button>

            <ResendButton onResend={onResendCode} disabled={submitting} />
          </Stack>
        </form>
      ) : (
        <Stack gap="7" animation="fade-up">
          <Stack gap="5">
            <OAuthButtonRow
              pending={oauthLoading}
              disabled={!isLoaded || submitting}
              onSelect={onOAuthSignUp}
            />

            <LabeledDivider label="or" />
          </Stack>

          <form onSubmit={onCreateAccount}>
            <Stack gap="4">
              <Stack gap="1.5">
                <Label htmlFor="email" fontSize="13px" fontWeight="500">
                  Email
                </Label>
                <Input
                  autoComplete="email"
                  id="email"
                  name="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  required
                  type="email"
                  value={email}
                />
              </Stack>

              <Stack gap="1.5">
                <Label htmlFor="password" fontSize="13px" fontWeight="500">
                  Password
                </Label>
                <PasswordInput
                  autoComplete="new-password"
                  id="password"
                  name="password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  value={password}
                />
                <Text fontSize="12px" color="fg.subtle">
                  At least 8 characters.
                </Text>
              </Stack>

              <FormError message={error} />

              <Button
                width="full"
                disabled={submitting || email.trim().length === 0 || password.trim().length === 0}
                type="submit"
              >
                {submitting ? (
                  <>
                    <Spinner size="xs" borderTopColor="accent.contrast" />
                    Creating account…
                  </>
                ) : (
                  "Create account"
                )}
              </Button>

              <Box id="clerk-captcha" />
            </Stack>
          </form>
        </Stack>
      )}

      <Flex
        align="center"
        justify="space-between"
        pt="4"
        borderTopWidth="1px"
        borderTopColor="border.subtle"
      >
        <Text fontSize="13px" color="fg.muted">
          Already have an account?
        </Text>
        <Link href="/sign-in">
          <Box
            as="span"
            fontSize="13px"
            fontWeight="500"
            color="fg"
            textDecoration="underline"
            textUnderlineOffset="3px"
            textDecorationColor="border.emphasized"
            transition="text-decoration-color 120ms ease"
            _hover={{ textDecorationColor: "fg" }}
          >
            Sign in
          </Box>
        </Link>
      </Flex>
    </Stack>
  );
}
