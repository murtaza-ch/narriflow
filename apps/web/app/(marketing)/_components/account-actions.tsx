"use client";

import { forwardRef, useState } from "react";
import Link from "next/link";
import { useClerk, useUser } from "@clerk/nextjs";
import { HStack, Stack } from "@chakra-ui/react";
import { ArrowRight } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { AccountMenu } from "@/app/(app)/_components/account-menu";

const WORKSPACE_HREF = "/home";

function useAccount() {
  const { isLoaded, isSignedIn, user } = useUser();
  return { isLoaded, user: isSignedIn ? user : null };
}

/**
 * Desktop header actions. Signed out: Sign in + Get started. Signed in: Go to
 * workspace + the app's account menu. Until Clerk knows, the signed-out pair
 * holds its space invisibly so neither state flashes.
 */
export function HeaderAccountActions() {
  const { isLoaded, user } = useAccount();

  if (user) {
    return (
      <HStack gap="3">
        <Button variant="outline" size="sm" px="4" asChild>
          <Link href={WORKSPACE_HREF}>
            Go to workspace
            <ArrowRight size={14} />
          </Link>
        </Button>
        <AccountMenu
          firstName={user.firstName}
          lastName={user.lastName}
          email={user.primaryEmailAddress?.emailAddress ?? null}
          imageUrl={user.hasImage ? user.imageUrl : null}
        />
      </HStack>
    );
  }

  return (
    <HStack gap="2" visibility={isLoaded ? "visible" : "hidden"} aria-hidden={!isLoaded}>
      <Button variant="ghost" size="sm" asChild>
        <Link href="/?auth=sign-in">Sign in</Link>
      </Button>
      {/* Outline here — the page hero owns the one solid button */}
      <Button variant="outline" size="sm" px="4" asChild>
        <Link href="/?auth=sign-up">Get started</Link>
      </Button>
    </HStack>
  );
}

/** Mobile drawer footer: the same choice, stacked full width. */
export function MobileAccountActions() {
  const { isLoaded, user } = useAccount();
  const { signOut } = useClerk();
  const [signingOut, setSigningOut] = useState(false);

  if (user) {
    return (
      <Stack gap="2">
        <Button asChild w="full">
          <Link href={WORKSPACE_HREF}>
            Go to workspace
            <ArrowRight size={16} />
          </Link>
        </Button>
        <Button
          variant="outline"
          w="full"
          loading={signingOut}
          onClick={async () => {
            setSigningOut(true);
            try {
              await signOut({ redirectUrl: "/" });
            } finally {
              setSigningOut(false);
            }
          }}
        >
          Sign out
        </Button>
      </Stack>
    );
  }

  return (
    <Stack gap="2" visibility={isLoaded ? "visible" : "hidden"} aria-hidden={!isLoaded}>
      <Button asChild variant="outline" w="full">
        <Link href="/?auth=sign-in">Sign in</Link>
      </Button>
      <Button asChild w="full">
        <Link href="/?auth=sign-up">Get started</Link>
      </Button>
    </Stack>
  );
}

/**
 * Primary page CTA link. Signed out it opens sign-up with the given label;
 * signed in it goes to the workspace. Use inside `<Button asChild>`.
 */
export const StartLink = forwardRef<HTMLAnchorElement, { children: React.ReactNode } & Omit<React.ComponentProps<"a">, "href">>(
  function StartLink({ children, ...props }, ref) {
    const { user } = useAccount();
    return (
      <Link ref={ref} href={user ? WORKSPACE_HREF : "/?auth=sign-up"} {...props}>
        {user ? "Go to your workspace" : children}
      </Link>
    );
  },
);
