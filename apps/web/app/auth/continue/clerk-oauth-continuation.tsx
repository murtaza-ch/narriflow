"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { Stack, Text } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { ApiProvider } from "@/app/_components/api-provider";
import { SessionGate, useSessionGate } from "@/app/_components/workspace-query-gate";
import { authEntryHref } from "@/lib/auth-entry";
import { resolveAuthContinuation } from "@/lib/post-auth-redirect";

// Only a validated Clerk OAuth destination reaches here, after provisioning.
// Clerk carries the development browser session across the domain boundary.
export function ClerkOAuthContinuation({ href }: { href: string }) {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const [failed, setFailed] = useState(false);
  const continueOAuth = useCallback(async () => {
    setFailed(false);
    try { await clerk.redirectWithAuth(href); }
    catch { setFailed(true); }
  }, [clerk, href]);

  useEffect(() => {
    if (isLoaded) void continueOAuth();
  }, [isLoaded, continueOAuth]);

  return <Stack minH="100dvh" align="center" justify="center" p="6" gap="4">
    <Text role="status">{failed ? "The authorization page couldn’t open. Try again." : "Opening the authorization page…"}</Text>
    {failed && <Button onClick={continueOAuth}>Try again</Button>}
  </Stack>;
}

function Opening() {
  return <Stack minH="100dvh" align="center" justify="center" p="6" gap="4">
    <Spinner />
    <Text role="status">Opening your workspace…</Text>
  </Stack>;
}

/**
 * Identity bootstrap provisions the personal Workspace and adopts the effective
 * selection; only then is the destination followed. A page of this app is a
 * client navigation; an approved Clerk authorization page keeps its SDK hand-off.
 */
function Continue({ destination }: { destination: string | null }) {
  const router = useRouter();
  const { session } = useSessionGate();
  const target = resolveAuthContinuation(destination, window.location.origin, session.authContinuation);
  const path = target.kind === "app" ? target.path : null;
  useEffect(() => {
    if (path) router.replace(path);
  }, [path, router]);
  return target.kind === "clerk" ? <ClerkOAuthContinuation href={target.href} /> : <Opening />;
}

function SignedOutRedirect({ destination }: { destination: string | null }) {
  const router = useRouter();
  useEffect(() => { router.replace(authEntryHref("sign-in", destination)); }, [router, destination]);
  return <Opening />;
}

export function AuthContinuation({ destination }: { destination: string | null }) {
  const { isLoaded, userId } = useAuth();
  if (isLoaded && !userId) return <SignedOutRedirect destination={destination} />;
  // A rejected token must end in this page's retry, not another sign-in round trip.
  return (
    <ApiProvider fallback={<Opening />} onAuthenticationFailed={() => {}}>
      <SessionGate fallback={<Opening />}>
        <Continue destination={destination} />
      </SessionGate>
    </ApiProvider>
  );
}
