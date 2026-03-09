"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSignUp } from "@clerk/nextjs";
import { Box, Flex, Heading, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { LabeledDivider } from "@narriflow/ui/components/divider";
import { getClerkErrorMessage } from "../../_lib/clerk-error";

export default function SignUpPage() {
  const router = useRouter();
  const { isLoaded, signUp, setActive } = useSignUp();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

  async function onCreateAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLoaded || !signUp) return;

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await signUp.create({
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
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

  async function onVerifyEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLoaded || !signUp) return;

    setSubmitting(true);
    setError(null);

    try {
      const result = await signUp.attemptEmailAddressVerification({
        code: verificationCode.trim(),
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

  async function onResendCode() {
    if (!isLoaded || !signUp) return;

    setSubmitting(true);
    setError(null);

    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Unable to resend code. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  async function onOAuthSignUp(strategy: "oauth_google" | "oauth_facebook" | "oauth_microsoft") {
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
    <Stack gap="24px">
      <Stack gap="4px" textAlign="center">
        <Heading size="lg" fontWeight="600" letterSpacing="-0.02em">
          {awaitingVerification ? "Verify your email" : "Create your account"}
        </Heading>
        <Text fontSize="13px" color="fg.muted">
          {awaitingVerification
            ? "Enter the code we sent to your email."
            : "Start turning long-form content into social-ready assets."}
        </Text>
      </Stack>

      {awaitingVerification ? (
        <form onSubmit={onVerifyEmail}>
          <Stack gap="16px">
            <Stack gap="6px">
              <Label htmlFor="verificationCode">Verification code</Label>
              <Input
                autoComplete="one-time-code"
                id="verificationCode"
                name="verificationCode"
                onChange={(event) => setVerificationCode(event.target.value)}
                placeholder="Enter code from your email"
                required
                value={verificationCode}
              />
              <Text fontSize="12px" color="fg.muted">
                We sent a code to <Box as="span" fontWeight="500" color="fg">{email}</Box>.
              </Text>
            </Stack>

            {error && <Text fontSize="13px" color="danger.fg">{error}</Text>}

            <Flex gap="8px">
              <Button flex="1" disabled={submitting || verificationCode.trim().length === 0} type="submit">
                {submitting ? "Verifying..." : "Verify email"}
              </Button>
              <Button disabled={submitting} onClick={onResendCode} type="button" variant="outline">
                Resend
              </Button>
            </Flex>
          </Stack>
        </form>
      ) : (
        <>
          <form onSubmit={onCreateAccount}>
            <Stack gap="16px">
              <SimpleGrid columns={{ base: 1, sm: 2 }} gap="16px">
                <Stack gap="6px">
                  <Label htmlFor="firstName">First name</Label>
                  <Input
                    autoComplete="given-name"
                    id="firstName"
                    name="firstName"
                    onChange={(event) => setFirstName(event.target.value)}
                    type="text"
                    value={firstName}
                  />
                </Stack>
                <Stack gap="6px">
                  <Label htmlFor="lastName">Last name</Label>
                  <Input
                    autoComplete="family-name"
                    id="lastName"
                    name="lastName"
                    onChange={(event) => setLastName(event.target.value)}
                    type="text"
                    value={lastName}
                  />
                </Stack>
              </SimpleGrid>

              <Stack gap="6px">
                <Label htmlFor="email">Email</Label>
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

              <Stack gap="6px">
                <Label htmlFor="password">Password</Label>
                <Input
                  autoComplete="new-password"
                  id="password"
                  name="password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </Stack>

              <Stack gap="6px">
                <Label htmlFor="confirmPassword">Confirm password</Label>
                <Input
                  autoComplete="new-password"
                  id="confirmPassword"
                  name="confirmPassword"
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  type="password"
                  value={confirmPassword}
                />
              </Stack>

              {error && <Text fontSize="13px" color="danger.fg">{error}</Text>}

              <Button
                width="full"
                disabled={submitting || email.trim().length === 0 || password.trim().length === 0 || confirmPassword.length === 0}
                type="submit"
              >
                {submitting ? "Creating account..." : "Create account"}
              </Button>

              <Box id="clerk-captcha" />
            </Stack>
          </form>

          <LabeledDivider label="or continue with" />

          <Stack gap="8px">
            <Button
              disabled={Boolean(oauthLoading)}
              onClick={() => onOAuthSignUp("oauth_google")}
              type="button"
              variant="outline"
              w="full"
            >
              {oauthLoading === "oauth_google" ? "Connecting..." : "Google"}
            </Button>
            <Button
              disabled={Boolean(oauthLoading)}
              onClick={() => onOAuthSignUp("oauth_facebook")}
              type="button"
              variant="outline"
              w="full"
            >
              {oauthLoading === "oauth_facebook" ? "Connecting..." : "Facebook"}
            </Button>
            <Button
              disabled={Boolean(oauthLoading)}
              onClick={() => onOAuthSignUp("oauth_microsoft")}
              type="button"
              variant="outline"
              w="full"
            >
              {oauthLoading === "oauth_microsoft" ? "Connecting..." : "Microsoft"}
            </Button>
          </Stack>
        </>
      )}

      <Text textAlign="center" fontSize="13px" color="fg.muted">
        Already have an account?{" "}
        <Link href="/sign-in">
          <Box as="span" fontWeight="500" color="fg.accent" _hover={{ textDecoration: "underline" }}>
            Sign in
          </Box>
        </Link>
      </Text>
    </Stack>
  );
}
