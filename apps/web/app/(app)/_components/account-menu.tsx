"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { Box, Flex, Image, Stack, Text } from "@chakra-ui/react";
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
    <Box position="relative" ref={containerRef}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        style={{ all: "unset", cursor: "pointer" }}
      >
        <Flex
          h="9" w="9"
          align="center"
          justify="center"
          overflow="hidden"
          rounded="full"
          borderWidth="1px"
          borderColor="border"
          bg="bg.muted"
          textStyle="xs"
          fontWeight="semibold"
          color="fg"
          _hover={{ borderColor: "fg/30" }}
        >
          {imageUrl ? <Image alt={displayName} h="full" w="full" objectFit="cover" src={imageUrl} /> : initials}
        </Flex>
      </button>

      {open ? (
        <Box
          position="absolute"
          right="0"
          top="11"
          zIndex="40"
          w="64"
          rounded="xl"
          borderWidth="1px"
          borderColor="border"
          bg="bg.panel"
          p="3"
          shadow="xl"
          role="menu"
        >
          <Box borderBottomWidth="1px" borderColor="border" pb="3">
            <Text textStyle="sm" fontWeight="semibold" color="fg">{displayName}</Text>
            <Text truncate textStyle="xs" color="fg.muted">{email ?? "No email"}</Text>
          </Box>
          <Box pt="3">
            <Button width="full" disabled={isSigningOut} onClick={onSignOut} type="button" variant="outline">
              {isSigningOut ? "Signing out..." : "Sign out"}
            </Button>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
