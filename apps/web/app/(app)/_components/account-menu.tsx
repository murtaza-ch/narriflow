"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { Button } from "@narriflow/ui/components/button";

interface AccountMenuProps {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  imageUrl: string | null;
}

function getDisplayName(firstName: string | null, lastName: string | null) {
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : "Account";
}

function getInitials(firstName: string | null, lastName: string | null, email: string | null) {
  const source = [firstName, lastName].filter(Boolean) as string[];

  if (source.length > 0) {
    return source.map((part) => part.charAt(0).toUpperCase()).join("").slice(0, 2);
  }

  if (email && email.length > 0) {
    return email.charAt(0).toUpperCase();
  }

  return "U";
}

export function AccountMenu({ firstName, lastName, email, imageUrl }: AccountMenuProps) {
  const { signOut } = useClerk();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const displayName = useMemo(() => getDisplayName(firstName, lastName), [firstName, lastName]);
  const initials = useMemo(() => getInitials(firstName, lastName, email), [firstName, lastName, email]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, []);

  async function onSignOut() {
    if (isSigningOut) {
      return;
    }

    setIsSigningOut(true);

    try {
      await signOut({ redirectUrl: "/" });
    } finally {
      setIsSigningOut(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-xs font-semibold text-foreground transition hover:border-foreground/30"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {imageUrl ? <img alt={displayName} className="h-full w-full object-cover" src={imageUrl} /> : initials}
      </button>

      {open ? (
        <div className="absolute right-0 top-11 z-40 w-64 rounded-xl border border-border bg-card p-3 shadow-xl" role="menu">
          <div className="border-b border-border pb-3">
            <p className="text-sm font-semibold text-foreground">{displayName}</p>
            <p className="truncate text-xs text-muted-foreground">{email ?? "No email"}</p>
          </div>
          <div className="pt-3">
            <Button className="w-full" disabled={isSigningOut} onClick={onSignOut} type="button" variant="outline">
              {isSigningOut ? "Signing out..." : "Sign out"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
