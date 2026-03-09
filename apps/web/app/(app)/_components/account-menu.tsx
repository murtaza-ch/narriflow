"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { Box, Flex, Image, Text } from "@chakra-ui/react";
import { LogOut } from "lucide-react";

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
    if (isSigningOut) return;
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
        onClick={() => setOpen((v) => !v)}
        style={{ all: "unset", cursor: "pointer" }}
      >
        <Flex
          h="32px"
          w="32px"
          align="center"
          justify="center"
          overflow="hidden"
          borderRadius="full"
          borderWidth="1.5px"
          borderColor="border"
          bg="bg.muted"
          fontSize="11px"
          fontWeight="600"
          color="fg"
          transition="border-color 150ms ease"
          _hover={{ borderColor: "border.accent" }}
        >
          {imageUrl ? (
            <Image alt={displayName} h="full" w="full" objectFit="cover" src={imageUrl} />
          ) : (
            initials
          )}
        </Flex>
      </button>

      {open && (
        <Box
          position="absolute"
          right="0"
          top="40px"
          zIndex="40"
          w="200px"
          borderRadius="12px"
          borderWidth="1px"
          borderColor="border"
          bg="bg.panel"
          p="4px"
          shadow="md"
          role="menu"
        >
          <Box px="12px" py="8px" borderBottomWidth="1px" borderColor="border" mb="4px">
            <Text fontSize="13px" fontWeight="500" color="fg" truncate>
              {displayName}
            </Text>
            <Text fontSize="11px" color="fg.subtle" truncate>
              {email ?? "No email"}
            </Text>
          </Box>
          <Flex
            as="button"
            onClick={onSignOut}
            aria-disabled={isSigningOut}
            opacity={isSigningOut ? 0.5 : 1}
            pointerEvents={isSigningOut ? "none" : "auto"}
            align="center"
            gap="8px"
            w="full"
            px="12px"
            py="8px"
            borderRadius="8px"
            fontSize="13px"
            color="fg.muted"
            cursor="pointer"
            transition="all 150ms ease"
            _hover={{ bg: "bg.subtle", color: "fg" }}
            role="menuitem"
          >
            <LogOut size={14} />
            <Text>{isSigningOut ? "Signing out..." : "Sign out"}</Text>
          </Flex>
        </Box>
      )}
    </Box>
  );
}
