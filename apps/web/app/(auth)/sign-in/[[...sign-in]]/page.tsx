"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useSignIn } from "@clerk/nextjs";
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
    <div className="space-y-6">
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
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
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link className="text-xs text-muted-foreground hover:text-foreground" href="/forgot-password">
              Forgot password?
            </Link>
          </div>
          <Input
            autoComplete="current-password"
            id="password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Button className="w-full" disabled={!canSubmit} type="submit">
          {submitting ? "Signing in..." : "Sign in"}
        </Button>
      </form>

      <div className="space-y-3">
        <p className="text-center text-xs uppercase tracking-wide text-muted-foreground">or continue with</p>
        <div className="grid grid-cols-1 gap-2">
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
        </div>
      </div>

      <p className="text-center text-sm text-muted-foreground">
        New to Narriflow?{" "}
        <Link className="font-medium text-foreground hover:underline" href="/sign-up">
          Create an account
        </Link>
      </p>
    </div>
  );
}
