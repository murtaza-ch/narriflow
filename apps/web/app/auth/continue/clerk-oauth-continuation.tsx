"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";

// The server passes only a validated Clerk OAuth destination after provisioning.
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
