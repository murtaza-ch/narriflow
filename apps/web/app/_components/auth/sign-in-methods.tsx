"use client";

import { Grid, Portal, Tooltip, VisuallyHidden, chakra } from "@chakra-ui/react";
import { FingerprintPattern } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";

export type OAuthStrategy = "oauth_google" | "oauth_apple" | "oauth_microsoft";
export type SignInMethod = OAuthStrategy | "passkey";

/*
 * Third-party OAuth brand marks. Literal hex values are the providers'
 * own brand colors (the sanctioned brand-color exception) — never re-ink
 * these with theme tokens.
 */

function GoogleMark() {
  return (
    <chakra.svg width="20px" height="20px" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.63h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.8Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.29a7.22 7.22 0 0 1 0-4.58v-3.1H1.27a12 12 0 0 0 0 10.78l4.01-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.6 4.59 1.79l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.27 6.61l4.01 3.1C6.22 6.88 8.87 4.77 12 4.77Z"
      />
    </chakra.svg>
  );
}

function AppleMark() {
  return (
    <chakra.svg width="20px" height="20px" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M17.1 12.8c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.5-.1-2.9.9-3.6.9-.7 0-1.9-.9-3.1-.9-1.6 0-3.1.9-4 2.3-1.7 2.9-.4 7.2 1.2 9.6.8 1.1 1.6 2.4 2.8 2.3 1.1 0 1.6-.7 3.1-.7s1.9.7 3.2.7 2.1-1.1 2.8-2.3c.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.3-.9-2.3-3.9ZM14.7 5.9c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.8 1.4-.6.7-1.2 1.8-1.1 2.9 1.1.1 2.2-.5 2.9-1.3Z" />
    </chakra.svg>
  );
}

function MicrosoftMark() {
  return (
    <chakra.svg width="19px" height="19px" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </chakra.svg>
  );
}

const OAUTH_METHODS: Array<{ method: SignInMethod; label: string; mark: React.ReactNode }> = [
  { method: "oauth_google", label: "Continue with Google", mark: <GoogleMark /> },
  { method: "oauth_apple", label: "Continue with Apple", mark: <AppleMark /> },
  { method: "oauth_microsoft", label: "Continue with Microsoft", mark: <MicrosoftMark /> },
];
const PASSKEY_METHOD = {
  method: "passkey" as const,
  label: "Sign in with a passkey",
  mark: <FingerprintPattern size={20} strokeWidth={1.75} aria-hidden="true" />,
};

interface SignInMethodsProps {
  /** Method currently redirecting or waiting on the authenticator, or null. */
  pending: SignInMethod | null;
  disabled?: boolean;
  /** Offer passkey sign-in as a fourth tile. */
  passkey?: boolean;
  onSelect: (method: SignInMethod) => void;
}

/**
 * One row of equal icon tiles, the primary path into the app, rendered above
 * the email form. Visually hidden text names each tile; the tooltip repeats
 * it for pointer users.
 */
export function SignInMethods({ pending, disabled, passkey, onSelect }: SignInMethodsProps) {
  const methods = passkey ? [...OAUTH_METHODS, PASSKEY_METHOD] : OAUTH_METHODS;

  return (
    <Grid templateColumns={`repeat(${methods.length}, minmax(0, 1fr))`} gap="2.5" w="full">
      {methods.map(({ method, label, mark }) => {
        const busy = pending === method;
        return (
          <Tooltip.Root key={method} openDelay={150} closeDelay={0} positioning={{ placement: "top" }}>
            <Tooltip.Trigger asChild>
              <chakra.button
                type="button"
                aria-busy={busy}
                disabled={disabled || pending !== null}
                onClick={() => onSelect(method)}
                h="12"
                display="flex"
                alignItems="center"
                justifyContent="center"
                borderRadius="l2"
                borderWidth="1px"
                borderColor="border"
                bg="bg.subtle"
                color="fg"
                cursor="pointer"
                transition="background 120ms ease, border-color 120ms ease, transform 160ms ease, opacity 160ms ease"
                _hover={{ bg: "bg.muted", borderColor: "border.emphasized", transform: "translateY(-1px)" }}
                _active={{ transform: "translateY(0)" }}
                _disabled={{ cursor: "default", transform: "none", opacity: busy ? 1 : 0.4 }}
              >
                {busy ? <Spinner size="xs" /> : mark}
                <VisuallyHidden>{label}</VisuallyHidden>
              </chakra.button>
            </Tooltip.Trigger>
            <Portal>
              <Tooltip.Positioner>
                <Tooltip.Content
                  bg="bg.inverted"
                  color="fg.inverted"
                  borderRadius="l1"
                  px="2.5"
                  py="1.5"
                  fontSize="xs"
                  fontWeight="500"
                  boxShadow="md"
                >
                  {label}
                </Tooltip.Content>
              </Tooltip.Positioner>
            </Portal>
          </Tooltip.Root>
        );
      })}
    </Grid>
  );
}
