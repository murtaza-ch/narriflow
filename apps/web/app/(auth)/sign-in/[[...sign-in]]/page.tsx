"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useSignIn } from "@clerk/nextjs";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { Spinner } from "@narriflow/ui/components/spinner";
import { LabeledDivider } from "@narriflow/ui/components/divider";
import { AuthHeader } from "../../../components/auth-shell";
import { OAuthButtonRow, type OAuthStrategy } from "../../_components/oauth-buttons";
import { PasswordInput } from "../../_components/password-input";
import { FormError } from "../../_components/form-error";
import { getClerkErrorMessage } from "../../_lib/clerk-error";

export default function SignInPage() {
  const router = useRouter();
  const { isLoaded, signIn, setActive } = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<OAuthStrategy | null>(null);

  const canSubmit = useMemo(
    () => isLoaded && email.trim().length > 0 && password.trim().length > 0 && !submitting,
    [isLoaded, email, password, submitting],
  );

  function postAuthRedirect() {
    const redirectUrl = new URLSearchParams(window.location.search).get("redirect_url");
    if (!redirectUrl) return "/onboarding";
    const continueUrl = new URL("/auth/continue", window.location.origin);
    continueUrl.searchParams.set("redirect_url", redirectUrl);
    return `${continueUrl.pathname}${continueUrl.search}`;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLoaded || !signIn) return;

    setError(null);
    setSubmitting(true);

    try {
      const result = await signIn.create({ identifier: email.trim(), password });
      if (result.status !== "complete") {
        setError("Additional verification is required for this account.");
        return;
      }
      await setActive({ session: result.createdSessionId });
      router.push(postAuthRedirect());
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Authentication failed. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  async function onOAuthSignIn(strategy: OAuthStrategy) {
    if (!isLoaded || !signIn) return;

    setError(null);
    setOauthLoading(strategy);

    try {
      await signIn.authenticateWithRedirect({
        strategy,
        redirectUrl: "/sso-callback",
        redirectUrlComplete: postAuthRedirect(),
      });
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Authentication failed. Please try again."));
      setOauthLoading(null);
    }
  }

  return (
    <Stack gap="7">
      <AuthHeader
        eyebrow="Welcome back"
        title="Sign in to Narriflow"
        description="Pick up where your last clip left off."
      />

      <Stack gap="5">
        <OAuthButtonRow
          pending={oauthLoading}
          disabled={!isLoaded || submitting}
          onSelect={onOAuthSignIn}
        />

        <LabeledDivider label="or" />
      </Stack>

      <form onSubmit={onSubmit}>
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
            <Flex align="center" justify="space-between">
              <Label htmlFor="password" fontSize="13px" fontWeight="500">
                Password
              </Label>
              <Link href="/forgot-password">
                <Text
                  as="span"
                  fontSize="12px"
                  color="fg.muted"
                  textDecoration="underline"
                  textUnderlineOffset="3px"
                  textDecorationColor="border.emphasized"
                  transition="color 120ms ease"
                  _hover={{ color: "fg" }}
                >
                  Forgot password?
                </Text>
              </Link>
            </Flex>
            <PasswordInput
              autoComplete="current-password"
              id="password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              required
              value={password}
            />
          </Stack>

          <FormError message={error} />

          <Button width="full" disabled={!canSubmit} type="submit">
            {submitting ? (
              <>
                <Spinner size="xs" borderTopColor="accent.contrast" />
                Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </Stack>
      </form>

      <Flex
        align="center"
        justify="space-between"
        pt="4"
        borderTopWidth="1px"
        borderTopColor="border.subtle"
      >
        <Text fontSize="13px" color="fg.muted">
          New to Narriflow?
        </Text>
        <Link href="/sign-up">
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
            Create an account
          </Box>
        </Link>
      </Flex>
    </Stack>
  );
}
