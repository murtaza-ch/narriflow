"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSignUp } from "@clerk/nextjs";
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
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Complete your account</h2>
        <p className="text-sm text-muted-foreground">We need a few more details before creating your account.</p>
      </div>

      <form className="space-y-4" onSubmit={onSubmit}>
        {missingFields.length === 0 ? (
          <p className="text-sm text-muted-foreground">Finalizing your sign up...</p>
        ) : (
          missingFields.map((field) => (
            <div className="space-y-2" key={field}>
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
            </div>
          ))
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Button className="w-full" disabled={submitting || missingFields.length === 0} type="submit">
          {submitting ? "Saving..." : "Continue"}
        </Button>

        <div id="clerk-captcha" />
      </form>
    </div>
  );
}
