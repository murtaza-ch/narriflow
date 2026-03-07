"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useSignIn } from "@clerk/nextjs";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { getClerkErrorMessage } from "../../_lib/clerk-error";

export default function SignInPage() {
  const router = useRouter();
  const { isLoaded, signIn, setActive } = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => isLoaded && email.trim().length > 0 && password.trim().length > 0 && !submitting,
    [isLoaded, email, password, submitting],
  );

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      const result = await signIn.create({
        identifier: email.trim(),
        password,
      });

      if (result.status !== "complete") {
        setError("Additional verification is required for this account.");
        return;
      }

      await setActive({ session: result.createdSessionId });
      router.push("/onboarding");
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Authentication failed. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  async function onOAuthSignIn(strategy: "oauth_google" | "oauth_facebook" | "oauth_microsoft") {
    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setOauthLoading(strategy);

    try {
      await signIn.authenticateWithRedirect({
        strategy,
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/onboarding",
      });
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Authentication failed. Please try again."));
      setOauthLoading(null);
    }
  }

  return (
    <Stack gap="6">
      <form onSubmit={onSubmit}>
        <Stack gap="4">
          <Stack gap="2">
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
          <Stack gap="2">
            <Flex align="center" justify="space-between">
              <Label htmlFor="password">Password</Label>
              <Box asChild textStyle="xs" color="fg.muted" _hover={{ color: "fg" }}>
                <Link href="/forgot-password">
                  Forgot password?
                </Link>
              </Box>
            </Flex>
            <Input
              autoComplete="current-password"
              id="password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </Stack>

          {error ? <Text textStyle="sm" color="red.500">{error}</Text> : null}

          <Button width="full" disabled={!canSubmit} type="submit" variant="solid">
            {submitting ? "Signing in..." : "Sign in"}
          </Button>
        </Stack>
      </form>

      <Stack gap="3">
        <Text textAlign="center" textStyle="xs" textTransform="uppercase" letterSpacing="wide" color="fg.muted">or continue with</Text>
        <Stack gap="2">
          <Button
            disabled={Boolean(oauthLoading)}
            onClick={() => onOAuthSignIn("oauth_google")}
            type="button"
            variant="outline"
          >
            {oauthLoading === "oauth_google" ? "Connecting Google..." : "Continue with Google"}
          </Button>
          <Button
            disabled={Boolean(oauthLoading)}
            onClick={() => onOAuthSignIn("oauth_facebook")}
            type="button"
            variant="outline"
          >
            {oauthLoading === "oauth_facebook" ? "Connecting Facebook..." : "Continue with Facebook"}
          </Button>
          <Button
            disabled={Boolean(oauthLoading)}
            onClick={() => onOAuthSignIn("oauth_microsoft")}
            type="button"
            variant="outline"
          >
            {oauthLoading === "oauth_microsoft" ? "Connecting Microsoft..." : "Continue with Microsoft"}
          </Button>
        </Stack>
      </Stack>

      <Text textAlign="center" textStyle="sm" color="fg.muted">
        New to Narriflow?{" "}
        <Box asChild fontWeight="medium" color="fg" _hover={{ textDecoration: "underline" }}>
          <Link href="/sign-up">
            Create an account
          </Link>
        </Box>
      </Text>
    </Stack>
  );
}
