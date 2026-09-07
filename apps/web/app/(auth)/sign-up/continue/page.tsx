"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSignUp } from "@clerk/nextjs";
import { Box, Flex, Stack, Text, VStack } from "@chakra-ui/react";
import { CircleAlert } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { GhostFrame } from "@narriflow/ui/components/ghost-frame";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
import { Spinner } from "@narriflow/ui/components/spinner";
import { AuthHeader } from "../../../components/auth-shell";
import { FormError } from "../../_components/form-error";
import { getClerkErrorMessage } from "../../_lib/clerk-error";

const unsupportedFields = new Set(["phone_number"]);

function formatLabel(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getInputType(field: string) {
  if (field.includes("email")) {
    return "email";
  }

  if (field.includes("password")) {
    return "password";
  }

  return "text";
}

/** Centered spinner + caption for the transient states. */
function PendingState({ message }: { message: string }) {
  return (
    <VStack gap="3" py="8" aria-live="polite">
      <Spinner size="md" />
      <Text fontSize="14px" color="fg.muted">
        {message}
      </Text>
    </VStack>
  );
}

export default function ContinueSignUpPage() {
  const router = useRouter();
  const { isLoaded, signUp, setActive } = useSignUp();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const missingFields = useMemo(() => {
    if (!isLoaded || !signUp || !Array.isArray(signUp.missingFields)) {
      return [] as string[];
    }

    return signUp.missingFields
      .map((field) => String(field))
      .filter((field) => field.length > 0 && !unsupportedFields.has(field));
  }, [isLoaded, signUp]);

  useEffect(() => {
    if (!isLoaded || !signUp) {
      return;
    }

    if (signUp.status === "complete" && signUp.createdSessionId) {
      void setActive({ session: signUp.createdSessionId }).then(() => {
        router.replace("/onboarding");
      });
      return;
    }

    if (!signUp.id) {
      router.replace("/sign-up");
    }
  }, [isLoaded, signUp, setActive, router]);

  useEffect(() => {
    if (missingFields.length === 0) {
      return;
    }

    setValues((current) => {
      const next = { ...current };

      for (const field of missingFields) {
        if (!(field in next)) {
          next[field] = "";
        }
      }

      return next;
    });
  }, [missingFields]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!isLoaded || !signUp) {
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      const payload = Object.fromEntries(
        Object.entries(values)
          .filter(([, value]) => value.trim().length > 0)
          .map(([key, value]) => [key, value.trim()]),
      );

      const result = await signUp.update(payload);

      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        router.replace("/onboarding");
        return;
      }

      if (result.status === "missing_requirements") {
        setError("Please complete all required fields to continue.");
      }
    } catch (authError) {
      setError(getClerkErrorMessage(authError, "Could not complete sign up. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  // ——— Three disambiguated non-form states ———

  // 1 · Loading: Clerk is still hydrating (or we're bouncing to /sign-up).
  if (!isLoaded || !signUp || !signUp.id) {
    return (
      <Stack gap="7">
        <AuthHeader eyebrow="Almost there" title="Complete your account" />
        <PendingState message="Loading your sign-up…" />
      </Stack>
    );
  }

  // 2 · Done: sign-up is complete, the effect above is activating the session.
  if (signUp.status === "complete") {
    return (
      <Stack gap="7">
        <AuthHeader eyebrow="Almost there" title="Account created" />
        <PendingState message="Taking you to your workspace…" />
      </Stack>
    );
  }

  // 3 · Broken: loaded, not complete, but nothing left for us to ask for.
  if (missingFields.length === 0) {
    return (
      <Stack gap="7">
        <AuthHeader
          eyebrow="Something broke"
          title="We couldn't finish your sign-up"
          description="Your provider returned incomplete account details."
        />
        <Flex justify="center">
          <GhostFrame size="220px">
            <Flex color="danger.fg" aria-hidden="true">
              <CircleAlert size={20} />
            </Flex>
          </GhostFrame>
        </Flex>
        <Stack gap="3">
          <Button asChild width="full">
            <Link href="/sign-up">Start over</Link>
          </Button>
          <Text textAlign="center" fontSize="13px" color="fg.muted">
            or{" "}
            <Link href="/sign-in">
              <Box
                as="span"
                fontWeight="500"
                color="fg"
                textDecoration="underline"
                textUnderlineOffset="3px"
                textDecorationColor="border.emphasized"
                transition="text-decoration-color 120ms ease"
                _hover={{ textDecorationColor: "fg" }}
              >
                go back to sign in
              </Box>
            </Link>
          </Text>
        </Stack>
      </Stack>
    );
  }

  // The form: fields Clerk still needs.
  return (
    <Stack gap="7">
      <AuthHeader
        eyebrow="Almost there"
        title="Complete your account"
        description="Complete your account details."
      />

      <form onSubmit={onSubmit}>
        <Stack gap="4" animation="fade-up">
          {missingFields.map((field) => (
            <Stack gap="1.5" key={field}>
              <Label htmlFor={field} fontSize="13px" fontWeight="500">
                {formatLabel(field)}
              </Label>
              <Input
                id={field}
                name={field}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }))
                }
                required
                type={getInputType(field)}
                value={values[field] ?? ""}
              />
            </Stack>
          ))}

          <FormError message={error} />

          <Button width="full" disabled={submitting} type="submit" variant="solid">
            {submitting ? (
              <>
                <Spinner size="xs" borderTopColor="accent.contrast" />
                Saving…
              </>
            ) : (
              "Continue"
            )}
          </Button>

          <Box id="clerk-captcha" />
        </Stack>
      </form>
    </Stack>
  );
}
