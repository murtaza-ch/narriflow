"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { Box, Flex, Stack, Text, VStack } from "@chakra-ui/react";
import { CircleAlert } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { GhostFrame } from "@narriflow/ui/components/ghost-frame";
import { Spinner } from "@narriflow/ui/components/spinner";
import { AuthShell, AuthHeader } from "../../components/auth-shell";

/** If Clerk hasn't redirected us anywhere by now, surface an escape hatch. */
const CALLBACK_TIMEOUT_MS = 10_000;

export default function SSOCallbackPage() {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), CALLBACK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <AuthShell>
      {timedOut ? (
        <Stack gap="7" animation="fade-up">
          <AuthHeader
            eyebrow="Connection stalled"
            title="This is taking too long"
            description="Your provider didn't finish signing you in. Try again, or head back and use another method."
          />
          <Flex justify="center">
            <GhostFrame size="220px">
              <Flex color="danger.fg" aria-hidden="true">
                <CircleAlert size={20} />
              </Flex>
            </GhostFrame>
          </Flex>
          <Stack gap="3">
            <Button width="full" onClick={() => window.location.reload()}>
              Try again
            </Button>
            <Text textAlign="center" fontSize="13px" color="fg.muted">
              or{" "}
              <Link href="/sign-in">
                <Box
                  as="span"
                  fontWeight="500"
                  color="fg"
                  textDecoration="underline"
                  textUnderlineOffset="3px"
                  textDecorationColor="border.emphasized"
                  transition="text-decoration-color 120ms ease"
                  _hover={{ textDecorationColor: "fg" }}
                >
                  go back to sign in
                </Box>
              </Link>
            </Text>
          </Stack>
        </Stack>
      ) : (
        <VStack gap="3" py="8" aria-live="polite">
          <Spinner size="md" />
          <Text fontSize="14px" color="fg.muted">
            Completing sign in…
          </Text>
          <Text textStyle="data" fontSize="11px" color="fg.subtle">
            Contacting provider · Creating session
          </Text>
        </VStack>
      )}

      {/* Keep the callback handler mounted in both states so a slow
          exchange can still finish while the escape hatch is showing. */}
      <AuthenticateWithRedirectCallback
        continueSignUpUrl="/sign-up/continue"
        signInFallbackRedirectUrl="/onboarding"
        signInUrl="/sign-in"
        signUpFallbackRedirectUrl="/onboarding"
      />
      <Box id="clerk-captcha" />
    </AuthShell>
  );
}
