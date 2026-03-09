"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useSignIn } from "@clerk/nextjs";
import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { LabeledDivider } from "@narriflow/ui/components/divider";
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
      router.push("/onboarding");
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Authentication failed. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  async function onOAuthSignIn(strategy: "oauth_google" | "oauth_facebook" | "oauth_microsoft") {
    if (!isLoaded || !signIn) return;

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
    <Stack gap="24px">
      <Stack gap="4px" textAlign="center">
        <Heading size="lg" fontWeight="600" letterSpacing="-0.02em">
          Sign in to your account
        </Heading>
        <Text fontSize="13px" color="fg.muted">
          Welcome back. Enter your credentials to continue.
        </Text>
      </Stack>

      <form onSubmit={onSubmit}>
        <Stack gap="16px">
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
            <Flex align="center" justify="space-between">
              <Label htmlFor="password">Password</Label>
              <Link href="/forgot-password">
                <Text fontSize="12px" color="fg.muted" _hover={{ color: "fg" }} transition="color 150ms ease">
                  Forgot password?
                </Text>
              </Link>
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

          {error && <Text fontSize="13px" color="danger.fg">{error}</Text>}

          <Button width="full" disabled={!canSubmit} type="submit">
            {submitting ? "Signing in..." : "Sign in"}
          </Button>
        </Stack>
      </form>

      <LabeledDivider label="or continue with" />

      <Stack gap="8px">
        <Button
          disabled={Boolean(oauthLoading)}
          onClick={() => onOAuthSignIn("oauth_google")}
          type="button"
          variant="outline"
          w="full"
        >
          {oauthLoading === "oauth_google" ? "Connecting..." : "Google"}
        </Button>
        <Button
          disabled={Boolean(oauthLoading)}
          onClick={() => onOAuthSignIn("oauth_facebook")}
          type="button"
          variant="outline"
          w="full"
        >
          {oauthLoading === "oauth_facebook" ? "Connecting..." : "Facebook"}
        </Button>
        <Button
          disabled={Boolean(oauthLoading)}
          onClick={() => onOAuthSignIn("oauth_microsoft")}
          type="button"
          variant="outline"
          w="full"
        >
          {oauthLoading === "oauth_microsoft" ? "Connecting..." : "Microsoft"}
        </Button>
      </Stack>

      <Text textAlign="center" fontSize="13px" color="fg.muted">
        New to Narriflow?{" "}
        <Link href="/sign-up">
          <Box as="span" fontWeight="500" color="fg.accent" _hover={{ textDecoration: "underline" }}>
            Create an account
          </Box>
        </Link>
      </Text>
    </Stack>
  );
}
