"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import { createGuestReviewsClient, reviewQueries, reviewMutationOptions } from "@narriflow/api-client/reviews";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ReviewQueryProvider, reviewApiOrigin, useReviewTokenDigest } from "../[token]/review-client-model";
import { ReviewPending } from "../[token]/review-client";

export default function ReviewOptOutPage() {
  return <Suspense fallback={<ReviewPending />}><ReviewOptOut /></Suspense>;
}

function ReviewOptOut() {
  const token = useSearchParams().get("token") ?? "";
  const digest = useReviewTokenDigest(token);
  return <ReviewQueryProvider>
    <title>Review email preferences | Narriflow</title>
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <meta name="referrer" content="no-referrer" />
    {digest ? <OptOutConfirmation key={digest} token={token} digest={digest} /> : <ReviewPending />}
  </ReviewQueryProvider>;
}

function OptOutConfirmation({ token, digest }: { token: string; digest: string }) {
  const client = useMemo(() => createGuestReviewsClient({ baseUrl: reviewApiOrigin(), getSession: () => null }), []);
  const preview = useQuery({ ...reviewQueries.optOut(client, token, digest), enabled: Boolean(token) });
  const [error, setError] = useState<string | null>(null);
  const confirmation = useMutation({
    ...reviewMutationOptions,
    mutationFn: async () => (await client.review["opt-out"].$post({ json: { token } })).json(),
  });
  if (token && preview.isPending) return <ReviewPending />;
  const unavailable = !token || preview.isError || !preview.data;
  return <Flex minH="100dvh" bg="bg.sidebar" direction="column" align="center" justify="center" gap="6" px="4" py="10">
    <Logo size="md" />
    <Stack w="full" maxW="440px" gap="5" p={{ base: "6", sm: "8" }} bg="bg.panel" borderRadius="l3">
      <Heading as="h1" textStyle="title" fontSize="24px">{unavailable ? "This link isn't available" : confirmation.isSuccess ? "You're opted out" : "Stop automated review emails?"}</Heading>
      <Text fontSize="14px" color="fg.muted">{unavailable
        ? "Ask the sender for a new opt-out link."
        : confirmation.isSuccess
          ? `You won't receive automated review requests from ${confirmation.data.workspaceName}. The team can still invite you by hand.`
          : `${preview.data?.workspaceName} will stop sending automated review requests to ${preview.data?.email}. The team can still invite you by hand.`}</Text>
      {error ? <Box role="alert"><Text fontSize="13px" color="danger.fg">{error}</Text></Box> : null}
      {!unavailable && !confirmation.isSuccess ? <Button disabled={confirmation.isPending} onClick={() => {
        setError(null);
        void confirmation.mutateAsync().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Your preference could not be saved."));
      }}>{confirmation.isPending ? "Saving…" : "Stop automated review emails"}</Button> : null}
    </Stack>
  </Flex>;
}
