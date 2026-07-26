"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSignIn } from "@clerk/nextjs";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { Spinner } from "@narriflow/ui/components/spinner";
import { OTPInput } from "@narriflow/ui/components/otp-input";
import { AuthHeader } from "../../components/auth-shell";
import { PasswordInput } from "../_components/password-input";
import { FormError } from "../_components/form-error";
import { ResendButton } from "../_components/resend-button";
import { getClerkErrorMessage } from "../_lib/clerk-error";

const CODE_LENGTH = 6;

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

  async function resendResetCode(): Promise<boolean> {
    if (!isLoaded || !signIn) return false;

    setError(null);

    try {
      await signIn.create({
        strategy: "reset_password_email_code",
        identifier: email.trim(),
      });
      return true;
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Unable to resend code. Please try again."));
      return false;
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
    <Stack gap="7">
      <AuthHeader
        eyebrow="Account recovery"
        title="Reset your password"
        description={
          step === "request" ? (
            "Enter your email to receive a reset code."
          ) : (
            <>
              Enter the {CODE_LENGTH}-digit code sent to{" "}
              <Box as="span" fontWeight="500" color="fg">
                {email}
              </Box>{" "}
              and pick a new password.
            </>
          )
        }
      />

      {step === "request" ? (
        <form onSubmit={sendResetCode}>
          <Stack gap="4" animation="fade-up">
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

            <FormError message={error} />

            <Button width="full" disabled={submitting || email.trim().length === 0} type="submit">
              {submitting ? (
                <>
                  <Spinner size="xs" borderTopColor="accent.contrast" />
                  Sending code…
                </>
              ) : (
                "Send reset code"
              )}
            </Button>
          </Stack>
        </form>
      ) : (
        <form onSubmit={resetPassword}>
          <Stack gap="4" animation="fade-up">
            <Stack gap="2" align="center" py="1">
              {/* Ark PinInput labels each digit box itself ("pin code 1 of 6") */}
              <Text fontSize="13px" fontWeight="500" color="fg">
                Reset code
              </Text>
              <OTPInput
                length={CODE_LENGTH}
                value={code}
                onValueChange={setCode}
                disabled={submitting}
              />
            </Stack>

            <Stack gap="1.5">
              <Label htmlFor="newPassword" fontSize="13px" fontWeight="500">
                New password
              </Label>
              <PasswordInput
                autoComplete="new-password"
                id="newPassword"
                name="newPassword"
                onChange={(event) => setNewPassword(event.target.value)}
                required
                value={newPassword}
              />
            </Stack>

            <FormError message={error} />

            <Flex gap="2">
              <Button
                flex="1"
                disabled={
                  submitting ||
                  code.trim().length < CODE_LENGTH ||
                  newPassword.trim().length === 0
                }
                type="submit"
              >
                {submitting ? (
                  <>
                    <Spinner size="xs" borderTopColor="accent.contrast" />
                    Resetting…
                  </>
                ) : (
                  "Reset password"
                )}
              </Button>
              <Button
                disabled={submitting}
                onClick={() => {
                  setStep("request");
                  setError(null);
                  setCode("");
                }}
                type="button"
                variant="outline"
              >
                Back
              </Button>
            </Flex>

            <ResendButton onResend={resendResetCode} disabled={submitting} />
          </Stack>
        </form>
      )}

      <Flex
        align="center"
        justify="space-between"
        pt="4"
        borderTopWidth="1px"
        borderTopColor="border.subtle"
      >
        <Text fontSize="13px" color="fg.muted">
          Remembered it?
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
