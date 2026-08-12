"use client";

import { useMemo, useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { Box, Flex, Image, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import Link from "next/link";
import { BadgeDollarSign, ChevronsUpDown, CreditCard, LogOut, UserRound } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { getDisplayName, getInitials } from "@/lib/account-display";

interface AccountMenuProps {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  imageUrl: string | null;
  /**
   * "avatar" — 32px circle trigger for the top bar.
   * "row" — full-width identity row trigger for the sidebar account cluster.
   */
  variant?: "avatar" | "row";
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
      borderWidth="1px"
      borderColor="border.emphasized"
      bg="bg.muted"
      fontSize="11px"
      fontWeight="600"
      color="fg"
      flexShrink={0}
    >
      {imageUrl ? (
        <Image alt={alt} h="full" w="full" objectFit="cover" src={imageUrl} />
      ) : (
        initials
      )}
    </Flex>
  );
}

const MENU_LINKS = [
  { label: "Account", href: "/settings/profile", icon: UserRound },
  { label: "Subscription", href: "/settings/subscription", icon: BadgeDollarSign },
] as const;

export function AccountMenu({
  firstName,
  lastName,
  email,
  imageUrl,
  variant = "avatar",
}: AccountMenuProps) {
  const { signOut } = useClerk();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);

  const displayName = useMemo(() => getDisplayName(firstName, lastName), [firstName, lastName]);
  const initials = useMemo(
    () => getInitials(firstName, lastName, email),
    [firstName, lastName, email],
  );

  async function onSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut({ redirectUrl: "/" });
    } finally {
      setIsSigningOut(false);
    }
  }

  async function openBillingPortal() {
    if (isOpeningPortal) return;
    setIsOpeningPortal(true);
    try {
      const response = await fetch("/api/billing/portal", { method: "POST" });
      const body = (await response.json()) as { url?: string; message?: string };
      if (!response.ok || !body.url) throw new Error(body.message ?? "Billing portal unavailable");
      window.location.assign(body.url);
    } finally {
      setIsOpeningPortal(false);
    }
  }

  return (
    <Menu.Root
      positioning={{ placement: variant === "row" ? "top-start" : "bottom-end", gutter: 6 }}
    >
      <Menu.Trigger asChild>
        {variant === "row" ? (
          <Flex
            as="button"
            aria-label="Account menu"
            w="full"
            align="center"
            gap="2.5"
            px="2.5"
            py="2"
            borderRadius="l2"
            textAlign="left"
            cursor="pointer"
            transition="background 120ms ease"
            _hover={{ bg: "bg.subtle" }}
          >
            <AccountAvatar imageUrl={imageUrl} initials={initials} alt={displayName} size="sm" />
            <Stack gap="0" minW="0" flex="1">
              <Text fontSize="13px" fontWeight="550" color="fg" truncate>
                {displayName}
              </Text>
              <Text fontSize="11px" color="fg.subtle" truncate>
                {email ?? ""}
              </Text>
            </Stack>
            <Box color="fg.subtle" flexShrink={0} aria-hidden="true">
              <ChevronsUpDown size={14} />
            </Box>
          </Flex>
        ) : (
          <Flex
            as="button"
            aria-label="Account menu"
            align="center"
            justify="center"
            borderRadius="full"
            cursor="pointer"
            transition="box-shadow 120ms ease"
            _hover={{ boxShadow: "0 0 0 2px var(--chakra-colors-border-emphasized)" }}
          >
            <AccountAvatar imageUrl={imageUrl} initials={initials} alt={displayName} />
          </Flex>
        )}
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content layerStyle="panel" boxShadow="cardHover" minW="14rem" p="1">
            <Box px="3" py="2" borderBottomWidth="1px" borderColor="border.subtle" mb="1">
              <Text fontSize="13px" fontWeight="600" color="fg" truncate>
                {displayName}
              </Text>
              <Text fontSize="12px" color="fg.muted" truncate>
                {email ?? "No email"}
              </Text>
            </Box>
            {MENU_LINKS.map(({ label, href, icon: Icon }) => (
              <Menu.Item key={href} value={href} asChild fontSize="13px" gap="2" borderRadius="l1">
                <Link href={href}>
                  <Icon size={14} />
                  {label}
                </Link>
              </Menu.Item>
            ))}
            <Menu.Item
              value="payment-billing"
              fontSize="13px"
              gap="2"
              borderRadius="l1"
              closeOnSelect={false}
              disabled={isOpeningPortal}
              onClick={openBillingPortal}
            >
              {isOpeningPortal ? <Spinner size="xs" /> : <CreditCard size={14} />}
              {isOpeningPortal ? "Opening billing…" : "Payment & billing"}
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item
              value="sign-out"
              fontSize="13px"
              gap="2"
              borderRadius="l1"
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
