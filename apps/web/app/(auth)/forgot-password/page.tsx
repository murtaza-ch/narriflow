"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSignIn } from "@clerk/nextjs";
import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { getClerkErrorMessage } from "../_lib/clerk-error";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const { isLoaded, signIn, setActive } = useSignIn();
  const [step, setStep] = useState<"request" | "verify">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function sendResetCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLoaded || !signIn) return;

    setError(null);
    setSubmitting(true);

    try {
      await signIn.create({
        strategy: "reset_password_email_code",
        identifier: email.trim(),
      });
      setStep("verify");
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Password reset failed. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  async function resetPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLoaded || !signIn) return;

    setError(null);
    setSubmitting(true);

    try {
      const result = await signIn.attemptFirstFactor({
        strategy: "reset_password_email_code",
        code: code.trim(),
        password: newPassword,
      });

      if (result.status !== "complete") {
        setError("Additional verification is required. Please try again.");
        return;
      }

      await setActive({ session: result.createdSessionId });
      router.push("/onboarding");
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Password reset failed. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Stack gap="24px">
      <Stack gap="4px" textAlign="center">
        <Heading size="lg" fontWeight="600" letterSpacing="-0.02em">
          Reset your password
        </Heading>
        <Text fontSize="13px" color="fg.muted">
          {step === "request"
            ? "Enter your email to receive a reset code."
            : "Enter the code and your new password."}
        </Text>
      </Stack>

      {step === "request" ? (
        <form onSubmit={sendResetCode}>
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

            {error && <Text fontSize="13px" color="danger.fg">{error}</Text>}

            <Button width="full" disabled={submitting || email.trim().length === 0} type="submit">
              {submitting ? "Sending code..." : "Send reset code"}
            </Button>
          </Stack>
        </form>
      ) : (
        <form onSubmit={resetPassword}>
          <Stack gap="16px">
            <Stack gap="6px">
              <Label htmlFor="code">Reset code</Label>
              <Input
                autoComplete="one-time-code"
                id="code"
                name="code"
                onChange={(event) => setCode(event.target.value)}
                placeholder="Enter code from your email"
                required
                value={code}
              />
            </Stack>
            <Stack gap="6px">
              <Label htmlFor="newPassword">New password</Label>
              <Input
                autoComplete="new-password"
                id="newPassword"
                name="newPassword"
                onChange={(event) => setNewPassword(event.target.value)}
                required
                type="password"
                value={newPassword}
              />
            </Stack>

            {error && <Text fontSize="13px" color="danger.fg">{error}</Text>}

            <Flex gap="8px">
              <Button
                flex="1"
                disabled={submitting || code.trim().length === 0 || newPassword.trim().length === 0}
                type="submit"
              >
                {submitting ? "Resetting..." : "Reset password"}
              </Button>
              <Button
                disabled={submitting}
                onClick={() => { setStep("request"); setError(null); }}
                type="button"
                variant="outline"
              >
                Back
              </Button>
            </Flex>
          </Stack>
        </form>
      )}

      <Text textAlign="center" fontSize="13px" color="fg.muted">
        Remembered it?{" "}
        <Link href="/sign-in">
          <Box as="span" fontWeight="500" color="fg.accent" _hover={{ textDecoration: "underline" }}>
            Sign in
          </Box>
        </Link>
      </Text>
    </Stack>
  );
}
