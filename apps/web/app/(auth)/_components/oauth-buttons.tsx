"use client";

import { Flex, HStack, chakra } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";

export type OAuthStrategy = "oauth_google" | "oauth_facebook" | "oauth_microsoft";

/*
 * Third-party OAuth brand marks. Literal hex values are the providers'
 * own brand colors (the sanctioned brand-color exception) — never re-ink
 * these with theme tokens.
 */

function GoogleMark() {
  return (
    <chakra.svg width="18px" height="18px" viewBox="0 0 24 24" aria-hidden="true">
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

function FacebookMark() {
  return (
    <chakra.svg width="18px" height="18px" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#1877F2"
        d="M24 12a12 12 0 1 0-13.88 11.85v-8.38H7.08V12h3.04V9.36c0-3 1.79-4.67 4.53-4.67 1.31 0 2.68.24 2.68.24v2.95h-1.51c-1.49 0-1.95.92-1.95 1.87V12h3.32l-.53 3.47h-2.79v8.38A12 12 0 0 0 24 12Z"
      />
    </chakra.svg>
  );
}

function MicrosoftMark() {
  return (
    <chakra.svg width="17px" height="17px" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </chakra.svg>
  );
}

const PROVIDERS: Array<{
  strategy: OAuthStrategy;
  label: string;
  mark: React.ReactNode;
}> = [
  { strategy: "oauth_google", label: "Continue with Google", mark: <GoogleMark /> },
  { strategy: "oauth_facebook", label: "Continue with Facebook", mark: <FacebookMark /> },
  { strategy: "oauth_microsoft", label: "Continue with Microsoft", mark: <MicrosoftMark /> },
];

interface OAuthButtonRowProps {
  /** Strategy currently redirecting, or null. Disables the whole row. */
  pending: OAuthStrategy | null;
  disabled?: boolean;
  onSelect: (strategy: OAuthStrategy) => void;
}

/**
 * Row of three equal 44px OAuth icon buttons — the primary path into the
 * app, rendered above the email form on sign-in and sign-up. Quiet hairline
 * borders; the brand marks carry the identity.
 */
export function OAuthButtonRow({ pending, disabled, onSelect }: OAuthButtonRowProps) {
  return (
    <HStack gap="2.5" w="full">
      {PROVIDERS.map(({ strategy, label, mark }) => (
        <Button
          key={strategy}
          aria-label={label}
          title={label}
          disabled={disabled || Boolean(pending)}
          onClick={() => onSelect(strategy)}
          type="button"
          variant="outline"
          flex="1"
          h="11"
          borderColor="border"
          _hover={{ bg: "bg.subtle", borderColor: "border.emphasized" }}
        >
          <Flex align="center" justify="center">
            {pending === strategy ? <Spinner size="xs" /> : mark}
          </Flex>
        </Button>
      ))}
    </HStack>
  );
}
