"use client";

import { useMemo, useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { Box, Flex, Image, Menu, Portal, Text } from "@chakra-ui/react";
import Link from "next/link";
import { BadgeDollarSign, CreditCard, LogOut, UserRound, ExternalLink } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import { getDisplayName, getInitials } from "@/lib/account-display";
import { useUpgrade } from "./upgrade";
import { clearSignedInBrowserState } from "@/lib/sign-out-storage";

/**
 * What the menu needs from the signed-in app's API session. The shell supplies
 * it; the marketing header shows the same menu with no API session, so it has
 * neither a billing portal nor anything to clear on sign-out.
 */
export interface AccountSession {
  /** The Stripe billing portal URL for the selected Workspace. */
  openPortal(): Promise<string>;
  /** Aborts and clears everything cached for this person; returns a way back if sign-out fails. */
  beginSignOut(): () => void;
}

interface AccountMenuProps {
  session?: AccountSession;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  imageUrl: string | null;
}

/** Clerk avatar (image when present, initials otherwise). Shared by the shell. */
export function AccountAvatar({
  imageUrl,
  initials,
  alt,
  size = "md",
}: {
  imageUrl: string | null;
  initials: string;
  alt: string;
  size?: "sm" | "md";
}) {
  return (
    <Flex
      w={size === "sm" ? "7" : "8"}
      h={size === "sm" ? "7" : "8"}
      align="center"
      justify="center"
      overflow="hidden"
      borderRadius="full"
      bg="bg.soft"
      fontSize="12px"
      fontWeight="500"
      color="fg"
      flexShrink={0}
    >
      {imageUrl ? (
        <Image alt={alt} boxSize="full" objectFit="cover" src={imageUrl} />
      ) : (
        initials
      )}
    </Flex>
  );
}

const MENU_LINKS = [
  { label: "Account", href: "/settings/profile", icon: UserRound },
  { label: "Billing", href: "/settings/billing", icon: BadgeDollarSign },
] as const;

export function AccountMenu({
  session,
  firstName,
  lastName,
  email,
  imageUrl,
}: AccountMenuProps) {
  const { signOut } = useClerk();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  // The Stripe portal is the owner's, and exists once a subscription has
  // started; before that, "Billing" is where the plan is chosen.
  const { canManageBilling, billingMode } = useUpgrade();
  const showPortal = canManageBilling && billingMode !== "checkout";

  const displayName = useMemo(() => getDisplayName(firstName, lastName), [firstName, lastName]);
  const initials = useMemo(
    () => getInitials(firstName, lastName, email),
    [firstName, lastName, email],
  );

  async function onSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    // Abort and clear everything cached for this person before their session ends,
    // so nothing in flight can fail into a sign-in redirect and nothing outlives it.
    const restore = session?.beginSignOut();
    clearSignedInBrowserState(window.localStorage, window.sessionStorage);
    try {
      await signOut({ redirectUrl: "/" });
    } catch {
      restore?.();
    } finally {
      setIsSigningOut(false);
    }
  }

  async function openBillingPortal() {
    if (isOpeningPortal || !session) return;
    setIsOpeningPortal(true);
    try {
      window.location.assign(await session.openPortal());
    } catch {
      toaster.create({ type: "error", title: "The billing portal could not be opened", description: "Open Billing to manage your plan." });
    } finally {
      setIsOpeningPortal(false);
    }
  }

  return (
    <Menu.Root
      positioning={{ placement: "bottom-end", gutter: 6 }}
    >
      <Menu.Trigger asChild>
        <Flex
          as="button"
          aria-label="Account menu"
          align="center"
          justify="center"
          borderRadius="full"
          cursor="pointer"
          transition="opacity 120ms ease"
          _hover={{ opacity: 0.8 }}
        >
          <AccountAvatar imageUrl={imageUrl} initials={initials} alt={displayName} />
        </Flex>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="14rem">
            <Box px="2.5" py="2" mb="1">
              <Text fontSize="13px" fontWeight="500" color="fg" truncate>
                {displayName}
              </Text>
              <Text fontSize="12px" color="fg.muted" truncate>
                {email ?? "No email"}
              </Text>
            </Box>
            {MENU_LINKS.map(({ label, href, icon: Icon }) => (
              <Menu.Item key={href} value={href} asChild>
                <Link href={href}>
                  <Icon size={14} />
                  {label}
                </Link>
              </Menu.Item>
            ))}
            {showPortal ? <Menu.Item
              value="payment-billing"
              closeOnSelect={false}
              disabled={isOpeningPortal}
              onClick={openBillingPortal}
            >
              {isOpeningPortal ? <Spinner size="xs" /> : <CreditCard size={14} />}
              {/* Stripe's portal, apart from the plan page that "Billing" opens. */}
              {isOpeningPortal ? "Opening Stripe…" : "Invoices & payment"}
              {isOpeningPortal ? null : <Box as="span" ms="auto" color="fg.subtle"><ExternalLink size={12} aria-hidden /></Box>}
            </Menu.Item> : null}
            <Menu.Separator />
            <Menu.Item
              value="sign-out"
              closeOnSelect={false}
              disabled={isSigningOut}
              onClick={onSignOut}
            >
              {isSigningOut ? <Spinner size="xs" /> : <LogOut size={14} />}
              {isSigningOut ? "Signing out…" : "Sign out"}
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
