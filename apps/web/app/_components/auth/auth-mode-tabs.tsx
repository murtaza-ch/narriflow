"use client";

import Link from "next/link";
import { Flex, Grid } from "@chakra-ui/react";
import { authEntryHref } from "@/lib/auth-entry";

const TABS = [
  { mode: "sign-in", label: "Sign in" },
  { mode: "sign-up", label: "Create account" },
] as const;

/**
 * Sign in / Create account switch. Each tab is a link to its `?auth=` entry
 * URL, so switching works exactly like any other mode change: the modal
 * remounts the form for the new mode and keeps the destination.
 */
export function AuthModeTabs({
  mode,
  destination,
  disabled,
}: {
  mode: "sign-in" | "sign-up";
  destination: string | null;
  disabled?: boolean;
}) {
  return (
    <Grid
      templateColumns="1fr 1fr"
      gap="1"
      p="1"
      bg="bg.subtle"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l2"
    >
      {TABS.map((tab) => {
        const current = tab.mode === mode;
        return (
          <Flex
            key={tab.mode}
            asChild
            h="9"
            align="center"
            justify="center"
            borderRadius="l1"
            fontSize="13px"
            fontWeight="500"
            color={current ? "fg" : "fg.muted"}
            bg={current ? { _light: "bg.panel", _dark: "bg.muted" } : "transparent"}
            boxShadow={current ? "0 1px 2px rgba(0, 0, 0, 0.12), 0 0 0 1px var(--chakra-colors-border)" : "none"}
            transition="color 120ms ease, background 120ms ease"
            _hover={current ? undefined : { color: "fg" }}
          >
            <Link
              href={authEntryHref(tab.mode, destination)}
              replace
              scroll={false}
              aria-current={current ? "page" : undefined}
              aria-disabled={disabled}
              onClick={(event) => {
                if (disabled || current) event.preventDefault();
              }}
            >
              {tab.label}
            </Link>
          </Flex>
        );
      })}
    </Grid>
  );
}
