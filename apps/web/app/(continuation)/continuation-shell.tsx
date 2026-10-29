"use client";

import { type ReactNode, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex } from "@chakra-ui/react";
import { Logo } from "@narriflow/ui/components/logo";
import { ShellHeader, ShellPanel } from "@/app/(app)/_components/shell-panel";
import { ThemeToggle } from "@/app/(app)/_components/theme-toggle";
import { useIdentityScope } from "@/app/_components/api-provider";
import { SessionGate } from "@/app/_components/workspace-query-gate";
import { authEntryHref } from "@/lib/auth-entry";

const pending = <Box minH="100dvh" bg="bg.sidebar" />;

/** Sends a signed-out visitor to sign in and back to this exact link. */
function RequireSignIn({ children }: { children: ReactNode }) {
  const identity = useIdentityScope();
  const router = useRouter();
  useEffect(() => {
    if (identity !== null) return;
    const { pathname, search } = window.location;
    router.replace(authEntryHref("sign-in", `${pathname}${search}`));
  }, [identity, router]);
  return identity === null ? pending : children;
}

/**
 * The identity-only shell for signed-in continuations: signed-in required and
 * the identity bootstrap, but no selected-Workspace admission (no Workspace
 * bootstrap, billing read or paused-Workspace redirect). Same frame and panel
 * as the app's focused flows, minus the Workspace-scoped credits and account menu.
 */
export function ContinuationShell({ children }: { children: ReactNode }) {
  return (
    <RequireSignIn>
      <SessionGate fallback={pending}>
        <Flex direction="column" minH="100dvh" p={{ base: "0", lg: "2" }}>
          <ShellPanel>
            <ShellHeader
              start={
                <Link href="/home" aria-label="Narriflow home">
                  <Logo size="md" />
                </Link>
              }
            >
              <ThemeToggle />
            </ShellHeader>
            <Box as="main" flex="1" w="full" maxW="1400px" mx="auto" px={{ base: "4", md: "10" }} py={{ base: "5", md: "6" }}>
              {children}
            </Box>
          </ShellPanel>
        </Flex>
      </SessionGate>
    </RequireSignIn>
  );
}
