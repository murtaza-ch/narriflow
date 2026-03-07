"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSignUp } from "@clerk/nextjs";
import { Box, Heading, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Label } from "@narriflow/ui/components/label";
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

  return (
    <Stack gap="6">
      <Stack gap="1">
        <Heading as="h2" textStyle="lg" fontWeight="semibold" letterSpacing="tight">Complete your account</Heading>
        <Text textStyle="sm" color="fg.muted">We need a few more details before creating your account.</Text>
      </Stack>

      <form onSubmit={onSubmit}>
        <Stack gap="4">
          {missingFields.length === 0 ? (
            <Text textStyle="sm" color="fg.muted">Finalizing your sign up...</Text>
          ) : (
            missingFields.map((field) => (
              <Stack gap="2" key={field}>
                <Label htmlFor={field}>{formatLabel(field)}</Label>
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
            ))
          )}

          {error ? <Text textStyle="sm" color="red.500">{error}</Text> : null}

          <Button width="full" disabled={submitting || missingFields.length === 0} type="submit" variant="solid">
            {submitting ? "Saving..." : "Continue"}
          </Button>

          <Box id="clerk-captcha" />
        </Stack>
      </form>
    </Stack>
  );
}
