"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { Box, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { authContinuationHref, authEntryHref } from "@/lib/auth-entry";

function Callback() {
  const params = useSearchParams();
  const destination = params.get("redirect_url");
  const completion = authContinuationHref(destination);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 15_000);
    return () => clearTimeout(timer);
  }, []);

  return <Stack minH="100dvh" align="center" justify="center" gap="4" p="6">
    {timedOut ? <>
      <Text as="h1" fontSize="xl" fontWeight="600">Sign-in is taking longer than expected</Text>
      <Button onClick={() => window.location.reload()}>Try again</Button>
      <Link href={authEntryHref("sign-in", destination)}>Choose another sign-in method</Link>
    </> : <><Spinner /><Text role="status">Completing sign-in…</Text></>}
    <AuthenticateWithRedirectCallback
      continueSignUpUrl={authEntryHref("continue", destination)}
      signInUrl={authEntryHref("sign-in", destination)}
      signUpUrl={authEntryHref("sign-up", destination)}
      firstFactorUrl={authEntryHref("sign-in", destination)}
      secondFactorUrl={authEntryHref("sign-in", destination)}
      resetPasswordUrl={authEntryHref("forgot-password", destination)}
      verifyEmailAddressUrl={authEntryHref("continue", destination)}
      signInForceRedirectUrl={completion}
      signUpForceRedirectUrl={completion}
    />
    <Box id="clerk-captcha" />
  </Stack>;
}

export default function SSOCallbackPage() {
  return <Suspense fallback={null}><Callback /></Suspense>;
}
