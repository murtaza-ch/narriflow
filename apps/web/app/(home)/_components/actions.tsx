"use client";

import { type FormEvent, type ReactNode, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";

const WORKSPACE_HREF = "/home";

function signUpHref(destination?: string) {
  return destination ? `/?auth=sign-up&redirect_url=${encodeURIComponent(destination)}` : "/?auth=sign-up";
}

/** Signed out: opens sign-up. Signed in: goes to the workspace. */
export function StartLink({ className, children }: { className?: string; children: ReactNode }) {
  const { isSignedIn } = useUser();
  return (
    <Link href={isSignedIn ? WORKSPACE_HREF : signUpHref()} scroll={false} className={className}>
      {isSignedIn ? "Open workspace" : children}
    </Link>
  );
}

export function SignInLink({ className }: { className?: string }) {
  const { isLoaded, isSignedIn } = useUser();
  if (isLoaded && isSignedIn) return null;
  return (
    <Link href="/?auth=sign-in" scroll={false} className={className} style={{ visibility: isLoaded ? "visible" : "hidden" }}>
      Sign in
    </Link>
  );
}

/**
 * Paste-a-link entry. The link survives sign-up: the auth modal's
 * `redirect_url` lands the new account on /upload with the source pre-filled.
 */
export function LinkForm({
  className,
  hint,
  placeholder = "Paste a video link",
}: {
  className?: string;
  hint?: ReactNode;
  placeholder?: string;
}) {
  const router = useRouter();
  const { isSignedIn } = useUser();
  const [url, setUrl] = useState("");
  const inputId = useId();
  const hintId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = url.trim();
    const upload = trimmed ? `/upload?url=${encodeURIComponent(trimmed)}` : "/upload";
    router.push(isSignedIn ? upload : signUpHref(upload), { scroll: false });
  }

  return (
    <div className={className ? `lx-linkform ${className}` : "lx-linkform"}>
      <form className="lx-linkform__field" onSubmit={submit}>
        <svg className="lx-linkform__icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2" />
          <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" />
        </svg>
        <label htmlFor={inputId} className="lx-sr">
          Video link
        </label>
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="off"
          placeholder={placeholder}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-describedby={hint ? hintId : undefined}
        />
        <button type="submit" className="lx-btn-go">
          Get clips
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </form>
      {hint ? (
        <p id={hintId} className="lx-linkform__hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The footer signup: an email field that opens account creation with the
 * address filled in. Signed-in visitors get a link to their workspace instead.
 */
export function SignupForm() {
  const router = useRouter();
  const { isSignedIn } = useUser();
  const [email, setEmail] = useState("");
  const inputId = useId();

  if (isSignedIn) {
    return (
      <Link href={WORKSPACE_HREF} className="lx-mono-btn">
        Open workspace
      </Link>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    router.push(address ? `/?auth=sign-up&email=${encodeURIComponent(address)}` : signUpHref(), { scroll: false });
  }

  return (
    <form className="lx-signup-form" onSubmit={submit}>
      <label htmlFor={inputId} className="lx-sr">
        Email address
      </label>
      <input
        id={inputId}
        type="email"
        autoComplete="email"
        placeholder="Enter your email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <button type="submit" aria-label="Create a free account">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </form>
  );
}
